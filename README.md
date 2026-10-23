# Top Deport (Node.js + Express)

Menu with sizes (1g to 1 oz, including 1/4 oz), cart, free delivery or store pickup, crypto payments (BTC, ETH, SOL, and USDT TRC20 once you add an address), and an admin panel at `/admin` for orders, stock, prices and images.

## Run locally
```bash
npm install
# Windows (cmd):  set ADMIN_PASSWORD=change-me
# Mac/Linux:      export ADMIN_PASSWORD=change-me
npm start
```
Open http://localhost:3000 and http://localhost:3000/admin (username: anything, password: your ADMIN_PASSWORD).

## Deploy: GitHub -> Render
1. Push this folder to GitHub (Visual Studio: Git > Create Git Repository > Push).
2. Render: New > Blueprint (reads `render.yaml`) or New > Web Service (Build `npm install`, Start `npm start`).
3. Render > Environment, set `ADMIN_PASSWORD` (required) and optionally `ORDER_WEBHOOK_URL`. Wallet addresses are already in `data/config.json` under `wallets`; to change one without editing code, set `WALLET_BTC`, `WALLET_ETH`, `WALLET_SOL` or `WALLET_USDT_TRC20` in Render (these override the file). Make your GitHub repo **private** so nobody can copy or tamper with your setup.
4. Add your domain under Settings > Custom Domains.

## Daily use (/admin)
- **Products tab:** untick "In stock" to mark a product out of stock (the site updates instantly), edit prices, add a sale "Was" price, paste an image URL, add or delete products.
- **Orders tab:** customers pay, paste their transaction ID, and the order shows "payment submitted". Check the TX ID on a block explorer (blockstream.info, etherscan.io, solscan.io, tronscan.org), then set status to Paid, Ready, Completed.

## Delivery
Checkout offers free delivery (default) or store pickup. Delivery orders ask for the receiving address and show it in the admin Orders tab. Delivery fee is always $0. Check your state's licensing rules for cannabis delivery.

## Crypto payments
At checkout the server converts the USD total to the coin amount using CoinGecko prices and shows your address. Payments are confirmed by you manually (the site does not read the blockchain). USDT is quoted 1:1 with USD and only appears at checkout once a TRC20 address is set. Make sure each wallet is on the right network.

## Images
Paste any https:// image URL in the admin (or in `data/products.seed.json`). Use photos you own or are licensed to use, hosted on a fast image host/CDN (for example Cloudinary, ImgBB, or Cloudflare R2). Images load lazily and fall back to a category label if a link breaks.

## IMPORTANT: persistent storage on Render
Stock changes, product edits and orders are saved to files. The free plan wipes files on every restart/deploy. `render.yaml` uses the Starter plan with a 1 GB Disk at `/var/data` (`DATA_DIR`) so your data survives. Without a disk, set `ORDER_WEBHOOK_URL` so orders are also sent to you, and expect product edits to reset.

## Customize
`data/config.json` (name, phone, email, tax rate, store locations), `data/products.seed.json` (starting menu, prices in cents), `public/about.html`, and colors at the top of `public/css/styles.css`.

## Compliance
Cannabis rules vary by state. Check your state's rules on online ordering, advertising, age verification and accepting crypto before launch.
