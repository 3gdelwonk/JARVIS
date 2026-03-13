# TASKS.md — Build Plan (Vibe Coding Sessions)

## How to Use This File
Each task is a self-contained unit you can tackle in one Claude coding session. Tasks are ordered by dependency — complete them top-to-bottom. Check off tasks as you complete them.

---

## Phase 1: Project Scaffold + Data Layer (Sessions 1-3)

### Session 1: Project Setup
- [ ] Initialize Vite + React + TypeScript project
- [ ] Install dependencies: dexie, papaparse, recharts, tailwindcss, lucide-react
- [ ] Configure Tailwind for mobile-first
- [ ] Set up Dexie database with all tables from SPECS.md
- [ ] Create `src/pwa/lib/db.ts` with typed Dexie instance
- [ ] Create `src/pwa/types.ts` with all TypeScript interfaces
- [ ] Create basic App shell with bottom navigation (Dashboard, Order, Margins, Import)
- [ ] Add PWA manifest.json and service worker stub
- [ ] Verify: app runs locally, database initializes

### Session 2: Seed Data + Product Master
- [ ] Create `src/pwa/data/seedProducts.ts` with all 45 products from CLAUDE.md catalogue
- [ ] Map Lactalis codes to Smart Retail barcodes (use Item Maintenance data)
- [ ] Create seed function that populates products table on first load
- [ ] Build product list view (simple table showing all products with key fields)
- [ ] Build product detail/edit screen (tap product → edit min stock, order qty, prices)
- [ ] Verify: all 45 products appear with correct codes and prices

### Session 3: CSV Import
- [ ] Build `src/pwa/lib/csvImporter.ts` — Item Maintenance parser
- [ ] Build `src/pwa/lib/csvImporter.ts` — Item Stock Report parser
- [ ] Build Import tab UI: file picker, drag-drop, progress indicator
- [ ] Handle column detection and mapping
- [ ] Handle dual-supplier rows (Lactalis vs Metcash)
- [ ] Show import results: X products updated, Y new, Z anomalies
- [ ] Test with actual `Item_Maintenance__Milk_.xlsx` and `Item_Stock_Report__Milk_.xlsx`

---

## Phase 2: Invoice Parser + Historical Data (Sessions 4-5)

### Session 4: Invoice Parser
- [ ] Build `src/pwa/lib/invoiceParser.ts` — PDF text extraction
- [ ] Parse invoice header (Document No, dates, totals, document type)
- [ ] Parse Delivery Note headers (delivery note #, date, PO #)
- [ ] Parse line items (product code, name, qty, all price columns)
- [ ] Handle Credit Notes and Adjustment Notes
- [ ] Handle edge cases: concatenated code+name, ** suffix, multi-page
- [ ] Store parsed data in InvoiceRecords + InvoiceLines tables
- [ ] Build invoice import UI: upload PDF, show parsed preview, confirm save
- [ ] Test with all 16 provided invoices

### Session 5: Historical Data Analysis
- [ ] Build `src/pwa/lib/historyAnalyzer.ts`
- [ ] Calculate per-product: order frequency, avg qty, qty range, price trend
- [ ] Calculate delivery patterns: days of week, deliveries per week
- [ ] Calculate spending: weekly average, per-delivery average
- [ ] Build order history view: list of past invoices with drill-down
- [ ] Build product history view: for a given product, show all orders over time
- [ ] Auto-populate product `defaultOrderQty` from invoice history median
- [ ] Verify: historical data matches manual analysis from CLAUDE.md

---

## Phase 3: Forecast Engine + Order Builder (Sessions 6-8)

### Session 6: Forecast Engine
- [ ] Build `src/pwa/lib/forecastEngine.ts`
- [ ] Implement: average daily sales from invoice-derived velocity
- [ ] Implement: reorder point calculation with configurable safety stock
- [ ] Implement: suggested quantity = (target days × daily sales) - current stock
- [ ] Handle products with no stock data (fall back to invoice avg)
- [ ] Handle products with no invoice history (flag as "insufficient data")
- [ ] Implement: manual multiplier (global and per-product)
- [ ] Build settings screen: lead time, safety stock multiplier, target days

### Session 7: Order Builder UI
- [ ] Build `src/pwa/components/OrderBuilder.tsx`
- [ ] Show suggested order grouped by urgency (critical → low → ok)
- [ ] Per item: name, current stock, avg daily sales, suggested qty, +/- buttons
- [ ] Inline editing: tap quantity to type directly
- [ ] Order summary bar: total items, total cost, comparison to average
- [ ] "Reset to Suggested" button
- [ ] "Approve Order" button → saves to Orders + OrderLines

### Session 8: Order Export
- [ ] Build CSV generation: Column A = lactalisSku, Column B = approvedQty
- [ ] Build paste format generation: "19100,18;18532,6;40248,12"
- [ ] "Copy for Paste" button → clipboard API
- [ ] "Download CSV" button → file download
- [ ] "Send to Extension" → save order to chrome.storage or shared location
- [ ] Order confirmation screen: summary of what was approved
- [ ] Order history list: past orders with status badges

---

## Phase 4: Dashboard + Margin Analysis (Sessions 9-10)

### Session 9: Dashboard
- [ ] Build `src/pwa/components/Dashboard.tsx`
- [ ] Next order countdown (from DeliverySchedule)
- [ ] Stock health bar (aggregated from products + snapshots)
- [ ] Reorder alerts (top 8 products needing reorder)
- [ ] Recent orders list with status
- [ ] Weekly spend chart (Recharts bar chart, last 8 weeks from invoice data)
- [ ] Quick action: "Build Next Order" button

### Session 10: Margin Analysis
- [ ] Build `src/pwa/components/MarginAnalysis.tsx`
- [ ] Per-product margin calculation: (sell - cost) / sell
- [ ] Dual-supplier comparison (Lactalis vs Metcash cost)
- [ ] Sort views: lowest margin, highest margin, most daily profit
- [ ] Margin threshold alerts (< 20% = red, < 28% = amber)
- [ ] Price change detection from invoice history
- [ ] Pricing recommendation: suggested sell price to maintain target margin

---

## Phase 5: Chrome Extension (Sessions 11-13)

### Session 11: Extension Scaffold
- [ ] Create `extension/manifest.json` (Manifest V3)
- [ ] Create `extension/background.js` (service worker)
- [ ] Create `extension/popup/popup.html` + `popup.js`
- [ ] Create `extension/content-scripts/main.js` (loader)
- [ ] Test: extension loads in Chrome, popup shows, content script runs on Lactalis

### Session 12: Schedule Scraper
- [ ] Build `extension/content-scripts/scheduleScraper.js`
- [ ] Parse header banner: delivery date + cutoff time
- [ ] Store schedule in chrome.storage.local
- [ ] Build "Manage my deliveries" page scraper (if accessible)
- [ ] Popup shows: next delivery date, cutoff countdown
- [ ] Test on live Lactalis portal

### Session 13: Quick Order Auto-Fill
- [ ] Build `extension/content-scripts/quickOrder.js`
- [ ] Detect Quick Order page
- [ ] Read pending order from chrome.storage
- [ ] Implement paste method: inject into textarea, trigger events
- [ ] Implement CSV upload method: create Blob, set on file input
- [ ] Show floating UI: "Fill Order" button with summary
- [ ] After fill: highlight "Create Order" button, show reminder
- [ ] Test on live Lactalis Quick Order page

---

## Phase 6: Integration + Polish (Sessions 14-16)

### Session 14: PWA ↔ Extension Sync
- [ ] Implement shared storage mechanism (options: Google Drive API, local file, chrome.storage)
- [ ] PWA "Send to Extension" → writes order to shared location
- [ ] Extension polls for new orders → shows badge count
- [ ] After order submitted on portal, extension updates status
- [ ] Status syncs back to PWA

### Session 15: Expiry Tracking
- [ ] Build delivery check-in flow (confirm received items, enter expiry dates)
- [ ] Build expiry dashboard (today / 1-2 days / 3+ days remaining)
- [ ] Local notifications for expiring products
- [ ] Waste logging (write-off with reason)
- [ ] Feed waste data back into forecast engine

### Session 16: Testing + Deploy
- [ ] Test full flow: import → forecast → approve → export → upload → reconcile
- [ ] Test with fresh Smart Retail exports
- [ ] Test with new Lactalis invoice
- [ ] Test Chrome extension on live portal
- [ ] Deploy PWA to GitHub Pages
- [ ] Load extension in Chrome
- [ ] Create backup/export mechanism for all data
- [ ] Write user guide (README.md)

---

## Future Enhancements (Post-MVP)
- [ ] Barcode scanner for product lookup and delivery check-in
- [ ] Multi-store support (if expanding)
- [ ] Automatic Smart Retail export detection (watch folder)
- [ ] Email parsing for Lactalis order confirmations
- [ ] Push notifications via web push
- [ ] Dark mode
- [ ] Data export to Excel for accounting
