# IGA Milk Manager

Automated milk ordering system for **IGA Camberwell** — PWA + Chrome Extension.

- **~45 SKUs**, 3 deliveries/week (Mon/Wed/Fri), ~$580/week
- PWA runs on any phone or PC, fully offline
- Chrome Extension auto-fills the Lactalis Quick Order portal
- No server, no subscription — everything stored on-device in IndexedDB

---

## Quick Start (Development)

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build → dist/
npm run preview    # preview production build locally
```

---

## Deploy to GitHub Pages

1. Create a GitHub repository (e.g. `iga-milk-manager`)
2. Push this project to the `main` branch
3. In GitHub → Settings → Pages → Source: **GitHub Actions**
4. The `.github/workflows/deploy.yml` workflow runs automatically on every push
5. PWA is live at `https://<your-username>.github.io/iga-milk-manager/`

To install the PWA on your phone:
- Open the URL in Chrome/Safari
- Tap the share button → **Add to Home Screen**

---

## Loading the Chrome Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked**
4. Select the `extension/` folder in this project
5. The milk bottle icon appears in your Chrome toolbar
6. Navigate to the Lactalis portal — the extension activates automatically

> The extension only activates on `lactalisaustralia.com.au` pages.
> It never auto-submits orders. Owner always clicks "Create Order".

---

## Daily Order Flow

### On your phone (PWA)

1. Open the **Milk Manager** app
2. **Home** tab — check stock alerts and next delivery date
3. Tap **Build Next Order** → **Order** tab opens
4. Review suggested quantities; tap +/− to adjust
5. Tap **Approve Order** — order is saved

### On your PC (Chrome Extension)

6. Open the Lactalis portal → navigate to **Quick Order**
7. Extension shows a floating panel: _"1 order ready — Fill Order"_
8. Click **Fill Order** — quantities are pasted into the Quick Order box
9. Review the items on the portal
10. Click **Create Order** ← you always click this, never the extension

---

## Weekly Import Flow

1. Log into Smart Retail → export **Item Maintenance (Milk)** → `.xlsx`
2. Optionally export **Item Stock Report (Milk)** → `.xlsx`
3. Open PWA → **Import** tab → drag files onto the upload zone
4. System updates product prices, stock levels, recalculates velocity

---

## Invoice Reconciliation Flow

1. Download invoice PDF from Lactalis portal
2. Open PWA → **Import** tab → tap **Upload Invoice PDF**
3. System parses the invoice, matches lines to products, updates price history
4. Go to **Invoice History** tab to review parsed invoices

---

## Expiry Tracking Flow

### After a delivery arrives

1. Go to **Expiry** tab → tap the pending delivery check-in
2. Confirm quantities received; set expiry dates for each SKU
3. Tap **Confirm Check-In** — batches are recorded

### Writing off waste

1. **Expiry** tab — expired or urgent batches shown at the top
2. Tap a batch → **Write Off** → enter qty, select reason
3. Waste is recorded and automatically feeds back into the forecast engine

---

## Forecast Settings

Tap the **gear icon** (top right) to adjust:

| Setting | Default | Effect |
|---|---|---|
| Lead Time | 1 day | Time between ordering and delivery |
| Safety Stock Multiplier | 1.5× | Buffer for demand variability (FMCG standard) |
| Target Days of Stock | 4 days | How much stock to carry post-delivery |
| Global Multiplier | 1.0× | Scale all suggested quantities up/down |

Formula: `qty = (targetDays × avgDailySales) + (1.5σ × √leadTime) − currentStock`

---

## Data Backup & Restore

All data is stored in IndexedDB on-device. To back up:

1. Tap the **gear icon** → scroll to **Data Backup**
2. Tap **Export Backup** — downloads `milk-manager-backup-YYYY-MM-DD.json`
3. Store the file in OneDrive/Google Drive

To restore on a new device:
1. Tap **gear icon** → **Restore** → select the `.json` backup file
2. All tables are restored. Reload the app.

---

## Project Structure

```
project/
├── src/
│   ├── App.tsx                        ← Root: tabs, error boundary, seed
│   └── pwa/
│       ├── components/
│       │   ├── Dashboard.tsx          ← Stock health, alerts, spend chart
│       │   ├── OrderBuilder.tsx       ← Generate, review, approve, export orders
│       │   ├── ExpiryTab.tsx          ← Check-in, expiry dashboard, write-off
│       │   ├── ImportTab.tsx          ← CSV + Invoice PDF import
│       │   ├── ProductList.tsx        ← Product catalogue management
│       │   ├── MarginAnalysis.tsx     ← Per-SKU margins, supplier comparison
│       │   ├── HistoryTab.tsx         ← Invoice history
│       │   └── SettingsSheet.tsx      ← Forecast params + data backup
│       ├── lib/
│       │   ├── db.ts                  ← Dexie database (10 tables, v3 schema)
│       │   ├── types.ts               ← All TypeScript interfaces
│       │   ├── forecastEngine.ts      ← Demand forecasting + reorder suggestions
│       │   ├── invoiceParser.ts       ← Lactalis PDF invoice parser
│       │   ├── csvImporter.ts         ← Smart Retail XLSX parser
│       │   ├── extensionSync.ts       ← PWA ↔ Extension bridge
│       │   ├── dataExport.ts          ← Full DB backup / restore
│       │   └── constants.ts           ← Shared constants + date helpers
│       └── data/
│           └── seedProducts.ts        ← 45 products from invoice analysis
│
├── extension/
│   ├── manifest.json                  ← MV3 manifest
│   ├── background.js                  ← Service worker
│   ├── popup/                         ← Extension popup UI
│   └── content-scripts/
│       ├── quickOrder.js              ← Auto-fill Quick Order page
│       └── scheduleScraper.js         ← Scrape delivery schedule from header
│
├── .github/workflows/deploy.yml       ← GitHub Pages auto-deploy
├── vite.config.ts
└── package.json
```

---

## Troubleshooting

**App won't load / blank screen**
- Hard refresh: Ctrl+Shift+R (or Cmd+Shift+R on Mac)
- Check browser console for errors
- If database error: Settings → Restore from last backup

**Extension not showing on Lactalis portal**
- Verify the extension is enabled in `chrome://extensions/`
- Reload the portal page after enabling
- Check that you're on `lactalisaustralia.com.au` (not a staging URL)

**Order quantities seem wrong**
- Check how many invoices have been imported (more = better accuracy)
- Adjust Safety Stock Multiplier or Global Multiplier in Settings
- For new products, set `defaultOrderQty` in Products tab manually

**Forecast shows "insufficient data"**
- Product has < 2 delivery events in invoice history
- Import more invoices, or manually set `defaultOrderQty` in Products tab

---

## Key Business Rules

- **Item numbers** = Lactalis invoice product code with leading zeros stripped (`00019100` → `19100`)
- **Prices** always stored ex-GST; margin calculations on consistent ex-GST basis
- **Dates** always `YYYY-MM-DD` strings (no Date objects in DB to avoid timezone bugs)
- **Money** rounded with `Math.round(val * 100) / 100` to avoid floating-point errors
- **Extension never auto-submits** — owner always clicks "Create Order" on the portal
- **QOH from Smart Retail is unreliable** (mostly negative) — forecast uses invoice velocity instead
