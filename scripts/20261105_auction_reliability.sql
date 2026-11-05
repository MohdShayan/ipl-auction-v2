-- Auction reliability migration.
--
-- Apply this file after scripts/supabase_schema.sql. It keeps the existing
-- JSONB room model, but moves bid acceptance, settlement, and queue changes
-- behind row locks so clients cannot win races with stale snapshots.

CREATE TABLE IF NOT EXISTS public.auction_bid_requests (
    auction_id TEXT NOT NULL REFERENCES public.auction_states(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    accepted BOOLEAN NOT NULL,
    reason TEXT,
    state JSONB,
    version INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (auction_id, request_id)
);

ALTER TABLE public.auction_bid_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can record auction bid requests"
    ON public.auction_bid_requests;
CREATE POLICY "Authenticated users can record auction bid requests"
    ON public.auction_bid_requests
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid()::text = user_id OR user_id LIKE 'bot_%');

DROP POLICY IF EXISTS "Authenticated users can read auction bid requests"
    ON public.auction_bid_requests;
CREATE POLICY "Authenticated users can read auction bid requests"
    ON public.auction_bid_requests
    FOR SELECT TO authenticated
    USING (auth.uid()::text = user_id OR user_id LIKE 'bot_%');

CREATE OR REPLACE FUNCTION public.place_auction_bid(
    p_auction_id TEXT,
    p_request_id TEXT,
    p_user_id TEXT,
    p_team_id TEXT,
    p_user_name TEXT,
    p_base_price NUMERIC
)
RETURNS TABLE(
    accepted BOOLEAN,
    reason TEXT,
    state JSONB,
    version INTEGER,
    server_now_ms BIGINT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    current_row public.auction_states%ROWTYPE;
    current_state JSONB;
    live JSONB;
    room JSONB;
    team JSONB;
    expected_bid NUMERIC;
    current_bid NUMERIC;
    increment NUMERIC;
    budget NUMERIC;
    now_ms BIGINT := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
    cached public.auction_bid_requests%ROWTYPE;
    is_bot BOOLEAN := p_user_id LIKE 'bot_%';
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN QUERY SELECT false, 'Authentication is required.', NULL::JSONB, 0, now_ms;
        RETURN;
    END IF;

    IF NOT is_bot AND auth.uid()::text <> p_user_id THEN
        RETURN QUERY SELECT false, 'Bidder identity does not match the signed-in user.', NULL::JSONB, 0, now_ms;
        RETURN;
    END IF;

    SELECT * INTO current_row
    FROM public.auction_states
    WHERE id = p_auction_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'Auction state was not found.', NULL::JSONB, 0, now_ms;
        RETURN;
    END IF;

    SELECT * INTO cached
    FROM public.auction_bid_requests
    WHERE auction_id = p_auction_id AND request_id = p_request_id;
    IF FOUND THEN
        RETURN QUERY SELECT cached.accepted, cached.reason, cached.state, cached.version, now_ms;
        RETURN;
    END IF;

    current_state := COALESCE(current_row.state, '{}'::JSONB);
    live := COALESCE(current_state -> 'live', '{}'::JSONB);
    room := COALESCE(current_state -> 'room', '{}'::JSONB);

    IF is_bot AND COALESCE(room ->> 'hostId', '') <> auth.uid()::text THEN
        RETURN QUERY SELECT false, 'Only the room host may place bot bids.', current_state, current_row.version, now_ms;
        RETURN;
    END IF;

    IF COALESCE(live ->> 'status', '') <> 'bidding' THEN
        RETURN QUERY SELECT false, 'Bidding is not open.', current_state, current_row.version, now_ms;
        RETURN;
    END IF;

    IF COALESCE((live ->> 'timerEndsAt')::BIGINT, 0) <= now_ms THEN
        RETURN QUERY SELECT false, 'The bidding timer has expired.', current_state, current_row.version, now_ms;
        RETURN;
    END IF;

    IF COALESCE(live ->> 'highBidderId', '') = p_user_id THEN
        RETURN QUERY SELECT false, 'You are already the highest bidder.', current_state, current_row.version, now_ms;
        RETURN;
    END IF;

    team := COALESCE(current_state -> 'teams' -> (p_auction_id || '_' || p_user_id), '{}'::JSONB);
    IF COALESCE(team ->> 'userId', '') <> p_user_id THEN
        RETURN QUERY SELECT false, 'Select a franchise before bidding.', current_state, current_row.version, now_ms;
        RETURN;
    END IF;

    IF COALESCE(jsonb_array_length(team -> 'squad'), 0) >= COALESCE((room ->> 'squadLimit')::INTEGER, 25) THEN
        RETURN QUERY SELECT false, 'Your squad limit has been reached.', current_state, current_row.version, now_ms;
        RETURN;
    END IF;

    current_bid := COALESCE((live ->> 'currentBid')::NUMERIC, 0);
    increment := CASE WHEN current_bid < 5 THEN 0.20 ELSE 0.25 END;
    expected_bid := CASE
        WHEN current_bid = 0 THEN COALESCE((live ->> 'basePrice')::NUMERIC, p_base_price, 0)
        ELSE ROUND((current_bid + increment)::NUMERIC, 2)
    END;

    budget := COALESCE((team ->> 'budgetRemaining')::NUMERIC, (room -> 'settings' ->> 'budget')::NUMERIC, 120);
    IF budget < expected_bid THEN
        RETURN QUERY SELECT false, 'Insufficient purse budget.', current_state, current_row.version, now_ms;
        RETURN;
    END IF;

    live := jsonb_set(live, '{currentBid}', to_jsonb(expected_bid), true);
    live := jsonb_set(live, '{highBidderId}', to_jsonb(p_user_id), true);
    live := jsonb_set(live, '{highBidderName}', to_jsonb(COALESCE(NULLIF(p_user_name, ''), 'Manager')), true);
    live := jsonb_set(live, '{highBidderTeamId}', to_jsonb(p_team_id), true);
    live := jsonb_set(
        live,
        '{timerEndsAt}',
        to_jsonb(now_ms + COALESCE((room -> 'settings' ->> 'bidTimer')::BIGINT, 10) * 1000),
        true
    );
    current_state := jsonb_set(current_state, '{live}', live, true);

    UPDATE public.auction_states AS auction_state
    SET state = current_state, version = auction_state.version + 1, updated_at = NOW()
    WHERE auction_state.id = p_auction_id
    RETURNING * INTO current_row;

    INSERT INTO public.auction_bid_requests (
        auction_id, request_id, user_id, accepted, reason, state, version
    ) VALUES (
        p_auction_id, p_request_id, p_user_id, true, NULL, current_row.state, current_row.version
    );

    RETURN QUERY SELECT true, NULL::TEXT, current_row.state, current_row.version, now_ms;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_auction_player(
    p_auction_id TEXT,
    p_actor_id TEXT
)
RETURNS TABLE(
    settled BOOLEAN,
    reason TEXT,
    state JSONB,
    version INTEGER,
    server_now_ms BIGINT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    current_row public.auction_states%ROWTYPE;
    current_state JSONB;
    live JSONB;
    room JSONB;
    teams JSONB;
    team JSONB;
    player_id TEXT;
    winner_id TEXT;
    team_key TEXT;
    order_ids JSONB;
    pending JSONB;
    next_player_id TEXT;
    next_index INTEGER;
    current_index INTEGER;
    is_sold BOOLEAN;
    now_ms BIGINT := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN QUERY SELECT false, 'Authentication is required.', NULL::JSONB, 0, now_ms;
        RETURN;
    END IF;

    SELECT * INTO current_row
    FROM public.auction_states
    WHERE id = p_auction_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'Auction state was not found.', NULL::JSONB, 0, now_ms;
        RETURN;
    END IF;

    current_state := COALESCE(current_row.state, '{}'::JSONB);
    room := COALESCE(current_state -> 'room', '{}'::JSONB);
    live := COALESCE(current_state -> 'live', '{}'::JSONB);

    IF auth.uid()::text <> p_actor_id
       AND auth.uid()::text <> COALESCE(room ->> 'hostId', '')
       AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(room -> 'players', '[]'::JSONB)) AS participant
           WHERE participant ->> 'id' = p_actor_id
       ) THEN
        RETURN QUERY SELECT false, 'You are not a participant in this auction.', current_state, current_row.version, now_ms;
        RETURN;
    END IF;

    IF COALESCE(live ->> 'status', '') <> 'bidding' THEN
        RETURN QUERY SELECT false, 'This player has already been settled.', current_state, current_row.version, now_ms;
        RETURN;
    END IF;

    IF COALESCE((live ->> 'timerEndsAt')::BIGINT, 0) > now_ms THEN
        RETURN QUERY SELECT false, 'The bidding timer has not expired.', current_state, current_row.version, now_ms;
        RETURN;
    END IF;

    player_id := live ->> 'playerId';
    winner_id := NULLIF(live ->> 'highBidderId', '');
    is_sold := winner_id IS NOT NULL;
    teams := COALESCE(current_state -> 'teams', '{}'::JSONB);

    IF is_sold THEN
        team_key := p_auction_id || '_' || winner_id;
        team := COALESCE(teams -> team_key, '{}'::JSONB);
        team := jsonb_set(
            team,
            '{budgetRemaining}',
            to_jsonb(GREATEST(
                0,
                COALESCE((team ->> 'budgetRemaining')::NUMERIC, (room -> 'settings' ->> 'budget')::NUMERIC, 120)
                - COALESCE((live ->> 'currentBid')::NUMERIC, 0)
            )),
            true
        );
        team := jsonb_set(
            team,
            '{spent}',
            to_jsonb(COALESCE((team ->> 'spent')::NUMERIC, 0) + COALESCE((live ->> 'currentBid')::NUMERIC, 0)),
            true
        );
        team := jsonb_set(
            team,
            '{squad}',
            COALESCE(team -> 'squad', '[]'::JSONB) || jsonb_build_array(
                jsonb_build_object('id', player_id, 'bid', COALESCE((live ->> 'currentBid')::NUMERIC, 0))
            ),
            true
        );
        teams := jsonb_set(teams, ARRAY[team_key], team, true);
    END IF;

    room := jsonb_set(
        room,
        '{appearedPlayerIds}',
        COALESCE(room -> 'appearedPlayerIds', '[]'::JSONB) || to_jsonb(player_id),
        true
    );
    IF is_sold THEN
        room := jsonb_set(
            room,
            '{soldPlayerIds}',
            COALESCE(room -> 'soldPlayerIds', '[]'::JSONB) || to_jsonb(player_id),
            true
        );
    ELSE
        room := jsonb_set(
            room,
            '{unsoldPlayerIds}',
            COALESCE(room -> 'unsoldPlayerIds', '[]'::JSONB) || to_jsonb(player_id),
            true
        );
    END IF;

    pending := COALESCE(room -> 'pendingQueue', '[]'::JSONB);
    pending := COALESCE((
        SELECT jsonb_agg(item.value ORDER BY item.index)
        FROM jsonb_array_elements_text(pending) WITH ORDINALITY AS item(value, index)
        WHERE item.value <> player_id
          AND NOT (
              COALESCE(room -> 'soldPlayerIds', '[]'::JSONB)
              @> to_jsonb(ARRAY[item.value]::TEXT[])
          )
    ), '[]'::JSONB);
    SELECT COALESCE(MIN(index - 1), -1) INTO current_index
    FROM jsonb_array_elements_text(COALESCE(room -> 'playerOrderIds', '[]'::JSONB))
         WITH ORDINALITY AS item(value, index)
    WHERE value = player_id;

    IF jsonb_array_length(pending) > 0 THEN
        next_player_id := pending ->> 0;
        pending := pending - 0;
    END IF;

    IF next_player_id IS NULL AND jsonb_array_length(COALESCE(room -> 'unsoldPlayerIds', '[]'::JSONB)) > 0 THEN
        live := jsonb_set(live, '{status}', to_jsonb('awaiting_unsold'::TEXT), true);
        live := jsonb_set(live, '{playerOrderIndex}', to_jsonb(current_index), true);
    ELSIF next_player_id IS NULL THEN
        room := jsonb_set(room, '{status}', to_jsonb('completed'::TEXT), true);
        live := jsonb_set(live, '{status}', to_jsonb('completed'::TEXT), true);
        live := jsonb_set(live, '{playerOrderIndex}', to_jsonb(current_index), true);
    ELSE
        SELECT COALESCE(MIN(index - 1), 0) INTO next_index
        FROM jsonb_array_elements_text(COALESCE(room -> 'playerOrderIds', '[]'::JSONB))
             WITH ORDINALITY AS item(value, index)
        WHERE value = next_player_id;
        live := jsonb_build_object(
            'playerId', next_player_id,
            'playerOrderIndex', next_index,
            'currentBid', 0,
            'highBidderId', '',
            'highBidderName', 'No Bids',
            'highBidderTeamId', '',
            'basePrice', COALESCE((room -> 'playerBasePrices' ->> next_player_id)::NUMERIC, 0),
            'timerEndsAt', now_ms + COALESCE((room -> 'settings' ->> 'bidTimer')::BIGINT, 10) * 1000,
            'status', 'bidding'
        );
    END IF;

    room := jsonb_set(room, '{pendingQueue}', pending, true);
    current_state := jsonb_set(current_state, '{room}', room, true);
    current_state := jsonb_set(current_state, '{live}', live, true);
    current_state := jsonb_set(current_state, '{teams}', teams, true);

    UPDATE public.auction_states AS auction_state
    SET state = current_state, version = auction_state.version + 1, updated_at = NOW()
    WHERE auction_state.id = p_auction_id
    RETURNING * INTO current_row;

    UPDATE public.auctions
    SET status = COALESCE(current_state -> 'room' ->> 'status', status),
        players = COALESCE(current_state -> 'room' -> 'players', players),
        banned_players = COALESCE(current_state -> 'room' -> 'bannedPlayers', banned_players),
        settings = COALESCE(current_state -> 'room' -> 'settings', settings),
        player_order = COALESCE(current_state -> 'room' -> 'playerOrder', player_order),
        updated_at = NOW()
    WHERE id = p_auction_id;

    INSERT INTO public.teams (
        id, auction_id, user_id, team_id, team_name, budget_remaining, spent, squad
    )
    SELECT
        p_auction_id || '_' || team_entry.key,
        p_auction_id,
        team_entry.value ->> 'userId',
        team_entry.value ->> 'teamId',
        team_entry.value ->> 'teamName',
        COALESCE((team_entry.value ->> 'budgetRemaining')::NUMERIC, 120),
        COALESCE((team_entry.value ->> 'spent')::NUMERIC, 0),
        COALESCE(team_entry.value -> 'squad', '[]'::JSONB)
    FROM jsonb_each(teams) AS team_entry
    ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        team_id = EXCLUDED.team_id,
        team_name = EXCLUDED.team_name,
        budget_remaining = EXCLUDED.budget_remaining,
        spent = EXCLUDED.spent,
        squad = EXCLUDED.squad;

    RETURN QUERY SELECT true, NULL::TEXT, current_row.state, current_row.version, now_ms;
END;
$$;

DROP FUNCTION IF EXISTS public.manage_auction_queue(TEXT, TEXT, TEXT, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.manage_auction_queue(
    p_auction_id TEXT,
    p_user_id TEXT,
    p_action TEXT,
    p_player_id TEXT,
    p_position INTEGER DEFAULT NULL,
    p_base_price NUMERIC DEFAULT NULL
)
RETURNS TABLE(
    changed BOOLEAN,
    reason TEXT,
    state JSONB,
    version INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    current_row public.auction_states%ROWTYPE;
    current_state JSONB;
    room JSONB;
    pending JSONB;
    current_player_id TEXT;
    sold JSONB;
    appeared JSONB;
    old_position INTEGER;
    target_position INTEGER;
BEGIN
    IF auth.uid() IS NULL OR auth.uid()::text <> p_user_id THEN
        RETURN QUERY SELECT false, 'Only the signed-in host may change the queue.', NULL::JSONB, 0;
        RETURN;
    END IF;

    SELECT * INTO current_row
    FROM public.auction_states
    WHERE id = p_auction_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'Auction state was not found.', NULL::JSONB, 0;
        RETURN;
    END IF;

    current_state := COALESCE(current_row.state, '{}'::JSONB);
    room := COALESCE(current_state -> 'room', '{}'::JSONB);
    IF COALESCE(room ->> 'hostId', '') <> p_user_id THEN
        RETURN QUERY SELECT false, 'Only the room host may change the queue.', current_state, current_row.version;
        RETURN;
    END IF;

    current_player_id := current_state -> 'live' ->> 'playerId';
    pending := COALESCE(room -> 'pendingQueue', '[]'::JSONB);
    sold := COALESCE(room -> 'soldPlayerIds', '[]'::JSONB);
    appeared := COALESCE(room -> 'appearedPlayerIds', '[]'::JSONB);

    IF p_action IN ('add_front', 'add_position') THEN
        IF p_player_id IS NULL OR p_player_id = current_player_id
           OR pending @> to_jsonb(ARRAY[p_player_id]::TEXT[])
           OR sold @> to_jsonb(ARRAY[p_player_id]::TEXT[])
           OR appeared @> to_jsonb(ARRAY[p_player_id]::TEXT[]) THEN
            RETURN QUERY SELECT false, 'That player is already active, completed, or queued.', current_state, current_row.version;
            RETURN;
        END IF;
        target_position := CASE
            WHEN p_action = 'add_front' THEN 0
            ELSE GREATEST(0, LEAST(COALESCE(p_position, jsonb_array_length(pending)), jsonb_array_length(pending)))
        END;
        pending := jsonb_insert(pending, ARRAY[target_position::TEXT], to_jsonb(p_player_id), false);
    ELSIF p_action = 'remove' THEN
        SELECT index - 1 INTO old_position
        FROM jsonb_array_elements_text(pending) WITH ORDINALITY AS item(value, index)
        WHERE value = p_player_id;
        IF old_position IS NULL THEN
            RETURN QUERY SELECT false, 'That player is not pending in the queue.', current_state, current_row.version;
            RETURN;
        END IF;
        pending := pending - old_position;
        room := jsonb_set(
            room,
            '{removedQueuePlayerIds}',
            COALESCE(room -> 'removedQueuePlayerIds', '[]'::JSONB) || to_jsonb(p_player_id),
            true
        );
    ELSIF p_action = 'move' THEN
        SELECT index - 1 INTO old_position
        FROM jsonb_array_elements_text(pending) WITH ORDINALITY AS item(value, index)
        WHERE value = p_player_id;
        IF old_position IS NULL THEN
            RETURN QUERY SELECT false, 'That player is not pending in the queue.', current_state, current_row.version;
            RETURN;
        END IF;
        target_position := GREATEST(0, LEAST(COALESCE(p_position, 0), jsonb_array_length(pending) - 1));
        pending := pending - old_position;
        pending := jsonb_insert(pending, ARRAY[target_position::TEXT], to_jsonb(p_player_id), false);
    ELSE
        RETURN QUERY SELECT false, 'Unsupported queue action.', current_state, current_row.version;
        RETURN;
    END IF;

    room := jsonb_set(room, '{pendingQueue}', pending, true);
    IF p_action IN ('add_front', 'add_position') THEN
        room := jsonb_set(
            room,
            '{playerOrderIds}',
            COALESCE(room -> 'playerOrderIds', '[]'::JSONB) || to_jsonb(p_player_id),
            true
        );
        room := jsonb_set(
            room,
            '{playerBasePrices}',
            jsonb_set(
                COALESCE(room -> 'playerBasePrices', '{}'::JSONB),
                ARRAY[p_player_id],
                to_jsonb(COALESCE(p_base_price, 0)),
                true
            ),
            true
        );
    END IF;
    current_state := jsonb_set(current_state, '{room}', room, true);

    UPDATE public.auction_states AS auction_state
    SET state = current_state, version = auction_state.version + 1, updated_at = NOW()
    WHERE auction_state.id = p_auction_id
    RETURNING * INTO current_row;

    RETURN QUERY SELECT true, NULL::TEXT, current_row.state, current_row.version;
END;
$$;

GRANT EXECUTE ON FUNCTION public.place_auction_bid(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.settle_auction_player(TEXT, TEXT)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.manage_auction_queue(TEXT, TEXT, TEXT, TEXT, INTEGER, NUMERIC)
    TO authenticated;
