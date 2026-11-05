<div align="center">


  # Crick Auction
  ### *The ultimate real-time SaaS auction and live fantasy experience.*

  [![React](https://img.shields.io/badge/React-19.2-20232A?style=flat-square&logo=react&logoColor=61DAFB)](https://reactjs.org/)
  [![Vite](https://img.shields.io/badge/Vite-6.0-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev/)
  [![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4.0-38B2AC?style=flat-square&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
  [![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=flat-square&logo=supabase&logoColor=white)](https://supabase.com/)

  Host live multiplayer auctions with friends, manage budgets, and bid in real-time.<br />
  Evaluate your drafted squad using the advanced Franchise Strength rating system.<br />
  Experience real-time bidding backed by Supabase PostgreSQL and Realtime.

  [Play Now](https://ipl-auction-wl1x.vercel.app/) • [Documentation](#documentation) • [Releases](https://github.com/DhruvTambekar24/IPL-AUCTION/releases) • [Contributing](#develop-and-contribute)
  <br />
  <br />
</div>

<p align="center">
  <img src="./readme-assets/auction_room.png" alt="Live Bidding Dashboard" width="100%">
</p>

## A platform for competitive multiplayer simulation
One host can manage an auction room. Running a live auction across multiple friends creates a different job: managing synchronized bid timers, tracking budgets, enforcing squad limits, and maintaining ultra-low latency.

Crick Auction is a real-time web workspace built for that job. Add friends to a lobby, assign franchise teams, and start a live bidding war. For every player that comes under the hammer, the platform synchronizes a universal clock offset across all clients. The current bid, highest bidder, remaining purses, and chat stay perfectly synced from start to finish.

Behind the React UI, Supabase PostgreSQL stores live room state and Supabase Realtime synchronizes activity. The result is a shared, broadcast-quality view of the auction instead of a chaotic group chat experience.

---

## How it works

### 1. Enter the Arena
When you open Crick Auction, the app connects to **Supabase PostgreSQL** to fetch public rooms and leaderboard history.
<div align="center">
  <img src="./readme-assets/loading%20page.png" alt="Dynamic Loader Screen" width="80%">
</div>
<br />

### 2. Create or Join an Auction
You can host a private room or jump into a public lobby. Each auction has a versioned state row in Supabase; Postgres compare-and-set transactions protect simultaneous bids, and Supabase Realtime streams updates to connected players.
<div align="center">
  <img src="./readme-assets/landing%20page.png" alt="Landing Page and Public Lobbies" width="80%">
</div>
<br />

### 3. Claim Franchises & Fill Bots
Once inside the lobby, you and your friends claim your favorite teams. If you don't have enough people to fill all the teams, you can turn on **AI Franchise Bots**. These bots use timer-adaptive bidding strategies—some bid aggressively early on, while others wait to snipe players in the final 5 seconds!
<div align="center">
  <img src="./readme-assets/auction_lobby.png" alt="Pre-Auction Lobby and Bot Configuration" width="80%">
</div>
<br />

### 4. The Live Bidding War
This is the core experience. When the auction starts, every connected user sees the exact same timer and bid amount instantly. The platform calculates a universal clock offset across all browsers to ensure fair bidding, preventing lag from ruining the fun. The host drives the pace while franchise owners manage their maximum purses and overseas player limits.
*(See the massive image at the top of this page!)*
<br />

### 5. Final Squads & Franchise Ratings
When all players are sold, the final room and team summaries remain in Supabase for later review. You can review every team's final squad, switch between list and detailed player cards, and see how your team ranks globally using the built-in **Franchise Strength** evaluation system.
<div align="center">
  <img src="./readme-assets/auction_summary.png" alt="Auction Results and Squad Summaries" width="80%">
</div>

---

## Install
Deploy or run the latest version of Crick Auction locally. No complex CLI is required.

1. **Clone and Install**
   ```bash
   git clone https://github.com/Shaurya01836/ipl-auction.git
   cd ipl-auction
   npm install
   ```

2. **Configure Supabase**
   Run [`scripts/supabase_schema.sql`](./scripts/supabase_schema.sql) in the Supabase SQL Editor, then run [`scripts/20261105_auction_reliability.sql`](./scripts/20261105_auction_reliability.sql). The second migration adds authoritative bid/settlement RPCs and host-controlled queue persistence; existing rooms should be restarted after applying it so their queue metadata is initialized. Enable Google and anonymous sign-in under **Authentication → Providers**, and enable Realtime for `public.auction_states`.
   Create a `.env` file with your Supabase project settings:
   ```env
   SUPABASE_URL=https://your_project_ref.supabase.co
   SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key

   VITE_CRICKET_API_KEY=your_cricapi_key
   ```
   Add your app URL to Supabase Auth's allowed redirect URLs for Google sign-in.

   Existing Firebase Auth users and Firebase records are **not copied automatically**. Users will need to sign in/create accounts through Supabase, and any historical Firebase data must be exported and migrated separately before switching production traffic.

   The maintenance scripts also require `SUPABASE_URL` and a server-side `SUPABASE_SECRET_KEY`. Keep the secret key private and never expose it through a `VITE_` variable or browser code. `SUPABASE_JWKS_URL` is only needed by a separate server that validates access tokens directly; this Vite app does not currently have such a backend.

   To play with friends on different Wi-Fi networks, deploy the Vite app to a public HTTPS host (for example, Vercel or Netlify) and add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` as that host's build environment variables. Add both the local development URL and deployed site URL to Supabase Auth's allowed redirect URLs. A local `npm run dev` server is not reachable by friends on other networks unless you separately expose it through a secure tunnel.

   **Vercel deployment:** import the repository into Vercel, keep the framework preset as Vite, use `npm run build` as the build command, and use `dist` as the output directory. Add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` for Production, Preview, and Development environments. The repository's `vercel.json` rewrite is required for direct navigation to `/lobby/:id`, `/auction/:id`, and `/summary/:id`. Never add `SUPABASE_SECRET_KEY` to Vercel because this frontend does not need it.

3. **Start the local daemon**
   ```bash
   npm run dev
   ```

---

## Product highlights

**Premium Broadcast UI/UX**
Sophisticated mobile UI featuring touch-scrollable participant overlays, micro-animations smoothed with Framer Motion, confetti explosions, and animated "SOLD" cards.

**Supabase Database Architecture**
Live auction state, persistent room history, feedback, and authentication use Supabase. PostgreSQL transactions coordinate bids, while Supabase Realtime synchronizes room state and presence.

**Automated Squad Evaluation**
Built-in evaluation algorithms automatically generate player ratings based on historical T20 career data, striking baselines, and experience vectors to objectively score the strength of every constructed franchise.

---

## Supported Tech Stack
The platform combines top-tier modern web technologies into one supervised workflow:

| Core Frontend | Styling & UI | Backend & Auth | Integration |
|---|---|---|---|
| React 19.2 | Tailwind CSS v4 | Supabase PostgreSQL | CricAPI |
| Vite 6.0 | Framer Motion | Supabase Auth & Realtime | Node.js Scripts |
| React Router | Lucide React | Supabase | html-to-image |

<br />

## Report a bug
Open a bug report from your own GitHub account. A few sentences in your own words about what you did and what went wrong are enough. Add what you expected, reproduction steps, your browser, or a screenshot if you have them. Use GitHub Issues for bugs and feature requests.

## Develop and contribute
Contributions are welcome across code, docs, examples, and tests. Start by cloning the repository and running `npm install`. Read the standard contribution guidelines before opening a pull request.

## Documentation
- **scripts/autoUpdateFantasy.js**: Auto-calculates points from live CricAPI matches.
- **scripts/backfillIPL2026.js**: Imports IPL series scorecards.
- **scripts/cleanup-supabase-auctions.js**: Removes completed or old auction records.
- **scripts/uploadConsolidatedPoints.js**: Uploads consolidated fantasy points.
- **scripts/supabase_schema.sql**: Creates the Supabase tables, policies, and live auction RPCs.

## Community
Join the discussion, follow updates, or start a conversation in GitHub Issues.

## License
Crick Auction is available under the Apache License 2.0.
