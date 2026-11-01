# Putting NavShiksha online for testing, free

NavShiksha runs as **one server** for testing: `npm run build` once, then `npm start` serves the web app and the API on one port. The first start builds the demo data: seven schools and about 1,170 students, all made up.

Set **`NES_TEST_PASSCODE`** whenever the server can be reached from the internet. Testers then type that passcode before they can pick a demo user. Without it, anyone who finds the address can sign in as anyone.

Things to know before choosing:
- The server needs about **1 GB of memory**, because the database is built in and held in memory.
- Free plans with 512 MB (Render free, Koyeb free) are too small.
- Vercel and Netlify cannot run it, because they do not keep a server running.
- Emails and SMS are **not sent** on a test server. They are recorded in the message log only, unless gateway addresses are set.
- Use **sample data only**. Never load real children's or staff details onto a test server.

## Option 1 · Today, from your Mac (about 5 minutes, no account)

A Cloudflare "quick tunnel" gives your running copy a public https address.

1. Install the tunnel program once (needs Homebrew):
   ```bash
   brew install cloudflared
   ```
2. In a terminal, build and start NavShiksha with a passcode of your choice:
   ```bash
   cd ~/Downloads/ERP/nes-erp
   ```
   ```bash
   npm run build
   ```
   ```bash
   NES_TEST_PASSCODE=choose-a-long-passcode npm start
   ```
3. In a **second** terminal:
   ```bash
   cloudflared tunnel --url http://localhost:8787
   ```
   It prints an address like `https://something-random.trycloudflare.com`.
4. Send testers that address and the passcode.

Limits:
- It works only while your Mac is awake and both terminals are open.
- The address changes every time you start the tunnel.
- If testers change data, it stays on your Mac. Delete `server/data` and start again to get fresh demo data.

## Option 2 · Always on, no card: a Hugging Face Docker Space

Hugging Face hosts Docker apps free on its "CPU basic" plan (2 CPUs, 16 GB memory).

Limits:
- The Space sleeps after 48 hours without visits. The first visit after that takes a few minutes.
- Data goes back to the demo data whenever the Space restarts or you update it.

1. Create a free account at huggingface.co.
2. Choose **New → Space**:
   - Name: e.g. `navshiksha`
   - SDK: **Docker** (Blank)
   - Hardware: CPU basic (free)
   - Visibility: Public (testers need no account; the passcode keeps strangers out)
3. In the Space's **Settings → Variables and secrets**, add a **secret** named `NES_TEST_PASSCODE` with your passcode.
4. Put the contents of the `nes-erp` folder into the Space, leaving out `node_modules`, `server/data` and `web/dist`. Either:
   - drag the files in under **Files → Add file → Upload files**, or
   - use git (sign in with your Hugging Face access token when asked):
     ```bash
     git clone https://huggingface.co/spaces/YOUR-NAME/navshiksha
     ```
     Copy the files in, then `git add -A`, `git commit -m "NavShiksha test server"` and `git push`.
5. Make sure the Space's `README.md` starts with this header:
   ```
   ---
   title: NavShiksha
   sdk: docker
   app_port: 7860
   ---
   ```
   You can add it to the top of `nes-erp/README.md`.

The Space builds the image from the `Dockerfile` (about 5–10 minutes the first time) and shows the app at `https://YOUR-NAME-navshiksha.hf.space`.

## Option 3 · Always on with lasting data: Oracle Cloud "Always Free" VM

Oracle gives a free Arm virtual machine (up to 4 CPUs and 24 GB of memory) that never sleeps and keeps its disk. Sign-up asks for a card to confirm identity; the Always Free resources are not charged.

1. Create an **Ampere A1** instance with Ubuntu 24.04 (for example 2 CPUs and 8 GB). Download the SSH key it offers.
2. Connect with SSH, then install Node.js 22 and unzip:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs unzip
   ```
3. Copy `NavShiksha.zip` to the server (for example with `scp`), unzip it, then inside `nes-erp`:
   ```bash
   npm run setup && npm run build
   ```
4. Start it with a passcode:
   ```bash
   NES_TEST_PASSCODE=choose-a-long-passcode npm start
   ```
   To keep it running after you log out, use `tmux`, or a `systemd` service.
5. For an https address, run `cloudflared tunnel --url http://localhost:8787` on the VM as in Option 1. A free Cloudflare account and a named tunnel keep the same address permanently.

## Which to choose

- To show it to a few people this week: **Option 1**.
- For testers over weeks without your Mac: **Option 2**, or **Option 3** if their changes must survive restarts.
