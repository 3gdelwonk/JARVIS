# CLAUDE_CODE_PROMPTS.md — Copy-Paste Prompts for Each Session

Use these prompts with Claude Code. Copy the relevant session prompt, paste it, and let Claude build.

---

## Session 0: Bootstrap (Run Once)

Open a terminal in your project folder and run:
```
setup.bat
```

If setup.bat doesn't work or you prefer manual steps:
```bash
npm create vite@latest . -- --template react-ts
npm install dexie dexie-react-hooks papaparse recharts lucide-react date-fns xlsx pdfjs-dist
npm install -D @types/papaparse tailwindcss postcss autoprefixer vitest vite-plugin-pwa
npx tailwindcss init -p
git init && git add -A && git commit -m "Initial scaffold"
```

---

## Session 1: Project Foundation

```
Read CLAUDE.md, SPECS.md, TASKS.md, and PITFALLS.md in this project.

Now complete Session 1 from TASKS.md:

1. Configure Tailwind for mobile-first in tailwind.config.js (content paths for ./src/**/*.tsx)
2. Set up the Tailwind directives in src/index.css (@tailwind base/components/utilities)
3. Create src/pwa/lib/types.ts with ALL TypeScript interfaces from SPECS.md Section 1 (Product, StockSnapshot, DeliverySlot, Order, OrderLine, InvoiceRecord, InvoiceLine, PriceRecord)
4. Create src/pwa/lib/db.ts — Dexie database instance with all tables and indexes from SPECS.md. Use version 1. Include a seedDatabase() function that checks if products table is empty and seeds from src/pwa/data/seedProducts.ts
5. Create the App shell in src/App.tsx with a bottom tab navigation (4 tabs: Dashboard, Order, Margins, Import) using lucide-react icons. Mobile-first layout capped at 480px width.
6. Create stub components for each tab: Dashboard.tsx, OrderBuilder.tsx, MarginAnalysis.tsx, ImportTab.tsx — each just showing the tab name for now
7. Add PWA manifest in public/manifest.json (name: "IGA Milk Manager", theme_color: "#2563eb", display: "standalone")
8. Call seedDatabase() in App.tsx useEffect on mount
9. Verify it compiles with npm run dev

IMPORTANT: The seedProducts.ts file already exists at src/pwa/data/seedProducts.ts — use it as-is. Check PITFALLS.md for the leading-zero stripping rule and money calculation helper.
```

---

## Session 2: Product Master UI

```
Read CLAUDE.md for product catalogue context, then complete Session 2 from TASKS.md:

1. Create src/pwa/components/ProductList.tsx — shows all seeded products in a scrollable list
   - Group by category (fresh / flavoured / uht)
   - Each row: product name, item number, cost price, sell price, margin %, order frequency badge
   - Tap row to expand/edit
2. Create inline edit for: minStockLevel, defaultOrderQty, targetDaysOfStock, sellPrice
3. Add a search/filter bar at top (search by name or item number)
4. Show product count per category
5. Add a "Verify Item Number" button that opens Lactalis Quick Order in a new tab (https://www.lactalis.com.au) so the owner can spot-check codes
6. Use Dexie's useLiveQuery hook to reactively display products from IndexedDB
7. Add ProductList as a new tab or accessible from Settings
8. Calculate margin as: ((sellPrice - costPrice) / sellPrice * 100).toFixed(1) — use the money helper (Math.round(val * 100) / 100) for all calculations

Test: npm run dev, navigate to products, verify all 53 products appear with correct data.
```

---

## Session 3: CSV Import

```
Read CLAUDE.md "Smart Retail Data" section and PITFALLS.md issues #7-#10, then complete Session 3 from TASKS.md:

1. Create src/pwa/lib/csvImporter.ts with two parsers:

   parseItemMaintenance(file: File): Promise<ImportResult>
   - Use SheetJS (xlsx) to read .xlsx files, PapaParse for .csv
   - Expected columns: Barcode, Description, Order Code, Supplier Code, Active, Normal Cost, Normal Sell, Current GP%, Normal GP%, Family, Department Code, Department Name, Commodity Name
   - Filter: Active = "Yes", Department Name = "MILK"
   - Dual-supplier logic: Supplier Code "01240657" = Lactalis, "90770" = Metcash
   - Match to existing products by barcode
   - Update costPrice (Lactalis) and metcashCost (Metcash) and sellPrice
   - Flag anomalies: cost > $20/unit for milk products (likely carton cost in unit field)
   - Return: { updated: number, new: number, anomalies: string[], skipped: number }

   parseStockReport(file: File): Promise<ImportResult>
   - Expected columns: Barcode, Description, Order Code, Supplier Name, ..., Carton Qty, ..., QOH
   - Store QOH as StockSnapshot with current timestamp
   - Skip rows where Barcode is null or "NH"
   - Return: { snapshots: number, matched: number, unmatched: number }

2. Create src/pwa/components/ImportTab.tsx:
   - Two sections: "Smart Retail Import" and "Lactalis Invoice Import" (invoice section stub for now)
   - File picker accepting .csv, .xlsx, .xls
   - Drag-and-drop zone
   - Auto-detect which report type based on column headers
   - Show import results with counts and any anomaly warnings
   - Show last import timestamp

CRITICAL: Handle BOM in CSV files. Handle both comma and tab delimiters. Use xlsx library for .xlsx files, not PapaParse.
```

---

## Session 4: Invoice Parser

```
Read CLAUDE.md "Invoice Structure" section and PITFALLS.md issues #1-#6, then complete Session 4 from TASKS.md.

IMPORTANT CONTEXT: Lactalis invoices are PDFs with a structured table layout. We have 16 sample invoices. The text content is available in CLAUDE.md. For MVP, build a TEXT-based parser (user pastes extracted text or we use pdfjs-dist). Perfect PDF extraction is a Phase 2 enhancement.

1. Create src/pwa/lib/invoiceParser.ts:

   parseInvoiceText(text: string): ParsedInvoice
   
   - Extract header: Document No, Date Ordered (DD.MM.YYYY), Invoice Date, Total Amount
   - Detect document type from header: "TAX INVOICE" vs "Adjustment Note" vs "Credit Adjustment Note"
   - Parse each "Delivery Note XXXXXX for DD.MM.YYYY Purchase Order XXXXXXX" block
   - Parse line items with regex. Handle these edge cases from PITFALLS.md:
     a. Product code concatenated with name: "PAULS SMARTER WHITE 2% FAT MILK BTL 1L00039466"
     b. ** suffix on product names: "PAULS ZYMIL FULL CREAM MILK 6x1L**"
     c. Credit notes (negative amounts, "CR" suffix)
     d. Both EA and CTN unit types
   - For each line item extract: productName, productCode (8-digit), quantity, unitType, listPrice, lineDiscount?, containerScheme?, gst?, extendedPrice, pricePerItem
   - pricePerItem is the ACTUAL cost (last column) — always use this
   
   - Normalize all dates to YYYY-MM-DD format using date-fns parse()
   - Store: InvoiceRecord + InvoiceLines in IndexedDB
   - Check for duplicate documentNumber before saving

2. Add invoice text paste area to ImportTab.tsx:
   - Large textarea: "Paste invoice text here"
   - Parse button → shows preview of extracted data (delivery notes, line items, totals)
   - Confirm button → saves to database
   - Show: "Invoice 242878938: 3 deliveries, 32 items, $556.60"

3. Also try basic pdfjs-dist integration:
   - Accept PDF file upload
   - Extract text using pdfjs-dist getTextContent()
   - Feed extracted text to parseInvoiceText()
   - If text extraction is garbled, fall back to paste method

Test with this sample invoice text (from Document 242878938):
"Delivery Note 221209 for 19.1.2026 Purchase Order 1660698
PHYSICAL LOW FAT MILK CTN 1L 00014584 2 EA 4.92 4.92 2.46000
PAULS FARMHOUSE GOLD MILK 1.5L 00048186 2 EA 7.22 7.22 3.61000"
```

---

## Session 5-8: Order Builder + Forecast (See TASKS.md)

Continue with TASKS.md Sessions 5-8. For each session, tell Claude Code:

```
Read CLAUDE.md and SPECS.md, then complete Session [N] from TASKS.md. 
Check PITFALLS.md for relevant edge cases.
After building, run npm run dev and verify the feature works.
```

---

## Session 11-13: Chrome Extension

```
Read CLAUDE.md (especially the "VERIFIED: Quick Order Item Numbers" section) and SPECS.md Section 3, then build the Chrome Extension:

Create these files in src/extension/:

1. manifest.json — Manifest V3, permissions: storage, activeTab, scripting. Host permissions: https://*.lactalis.com.au/*

2. content-scripts/main.js — Runs on all Lactalis pages. Detects which page (Quick Order, Favourites, any page with delivery banner). Loads appropriate sub-module.

3. content-scripts/scheduleScraper.js — On any Lactalis page, read the header banner. Extract delivery date and order cutoff (regex: "Delivery Date and Billing Address: ..." and "Place order before: DD/MM at HH:MMpm"). Store in chrome.storage.local.

4. content-scripts/quickOrder.js — On Quick Order page:
   - Check chrome.storage for pending order
   - If found, show floating button: "Fill Order (X items, ~$Y)"
   - On click, use PASTE METHOD (more reliable than file upload):
     - Find the paste textarea (placeholder contains "Copy and paste")
     - Set value to "801,3;1003,6;19100,18" format
     - Dispatch input event
     - Find and click "Verify Order" button
   - After verify: show success message, highlight "Create Order" button
   - NEVER click "Create Order" automatically
   - If paste textarea not found, fall back: copy to clipboard + show instructions

5. popup/popup.html + popup.js — Shows:
   - Connection status
   - Next delivery/cutoff (from chrome.storage)
   - Pending orders count
   - "Upload to Quick Order" button
   - Manual paste textarea (fallback)
   
6. Handle session timeout: if page shows login form instead of Quick Order, show "Please log in to Lactalis" message.

CSV upload format for reference: "Item Number,Quantity\n801,3\n1003,6\n19100,18"
Paste format: "801,3;1003,6;19100,18"

CRITICAL: Item numbers are invoice codes stripped of leading zeros. Use parseInt(code, 10).toString() to strip safely.
```

---

## Tips for Working with Claude Code

1. **Always start with "Read CLAUDE.md"** — this gives Claude the full project context
2. **One session at a time** — don't try to build everything in one prompt
3. **Test after each session** — run `npm run dev` and verify before moving on
4. **If something breaks** — tell Claude: "Read PITFALLS.md, the [specific feature] is failing because [symptom]"
5. **To add a new product** — tell Claude: "Add item number XXXXX to seedProducts.ts, name is [name], cost is $X.XX, category is flavoured, GST-bearing"
6. **To update prices** — import a new Smart Retail CSV or Lactalis invoice
7. **Git commit after each session** — `git add -A && git commit -m "Session N: [description]"`
