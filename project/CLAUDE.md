# CLAUDE.md — IGA Milk Manager

> **For Claude Code**: Read this file FIRST before any task. It contains verified business rules, product data, and architecture decisions. Refer to SPECS.md for technical details, TASKS.md for session-by-session build plan, PITFALLS.md for edge cases.

## Project Summary

**IGA Milk Manager** — A PWA + Chrome Extension that automates milk ordering for IGA Camberwell from the Lactalis Australia portal.

- **Store**: IGA Camberwell, 1401 Toorak Rd, Camberwell VIC 3125
- **Lactalis Customer No**: 7212916, Account No: 304804
- **~45 active SKUs**, 3 deliveries per week (Mon/Wed/Fri pattern), ~$580/week average spend
- **Semi-automated**: System suggests orders → owner reviews/approves on phone → Chrome extension uploads to Lactalis portal → owner clicks "Create Order"

## Architecture

```
┌─ PWA (React + TS + Vite) ──────────────────────────────────┐
│  Dashboard · Order Builder · Margins · CSV Import           │
│  Invoice Parser · Forecast Engine · Expiry Tracker          │
│  Data: IndexedDB via Dexie.js (all on-device, $0 cost)     │
└──────────────┬─── QR code / file download ─────────────────┘
               ▼
┌─ Chrome Extension (Manifest V3) ───────────────────────────┐
│  Auto-fill Lactalis Quick Order (paste or CSV upload)       │
│  Scrape delivery schedule from portal header                │
│  Never auto-submits — owner always clicks "Create Order"    │
└─────────────────────────────────────────────────────────────┘
```

**Tech stack**: React 18, TypeScript, Vite, Tailwind CSS, Dexie.js, PapaParse, SheetJS (xlsx), pdfjs-dist, Recharts, date-fns, lucide-react. Chrome Extension: Manifest V3, vanilla JS.

**Hosting**: GitHub Pages (free). No backend server. No database server. Everything on-device.

**Development environment**: Windows PC, VS Code, Node.js 18+, Git, Chrome.

---

## ✅ VERIFIED: Lactalis Quick Order Item Numbers

**Tested and confirmed on the live portal on 13 March 2026:**
- Quick Order accepts **invoice product codes stripped of leading zeros** as Item Numbers
- Typing `801` → finds "Pauls Milk Rev Low Fat 2L" ✅
- Typing `807` (portal Favourites SKU) → nothing found ❌
- **Portal "SKU" numbers shown on Favourites pages are display-only — they are NOT ordering codes**

**CSV upload format** (from downloaded template):
```csv
Item Number,Quantity
801,3
1003,6
19100,18
```

**Paste format** (for Quick Order paste box):
```
801,3;1003,6;19100,18
```

**Rules for item numbers:**
- Strip all leading zeros from invoice product code: `00019100` → `19100`
- No prefixes, dashes, or punctuation
- Use `parseInt(code, 10).toString()` to strip leading zeros safely

---

## Product Catalogue (45 SKUs from 16 invoices, Nov 2025 – Mar 2026)

### FRESH MILK — GST-free, ordered every or most deliveries

| Item Number | Name | Avg Qty | Price/Unit | Frequency |
|------------|------|---------|-----------|-----------|
| 19100 | Mooloo Mountain Full Cream Milk 2L | 18 | $3.16 | Every delivery |
| 40248 | Mooloo Mountain Lite Milk 2L | 10 | $3.27 | Every delivery |
| 18532 | Mooloo Mountain Full Cream Milk 3L | 7 | $4.74 | Every delivery |
| 39482 | Pauls Smarter White 2% Fat Milk 2L | 4 | $4.33 | Every delivery |
| 39466 | Pauls Smarter White 2% Fat Milk 1L | 4 | $2.41 | Every delivery |
| 801 | Rev Low Fat Milk 2L | 3 | $4.33 | Every delivery |
| 909 | Skinny Milk BTL 2L | 3 | $4.32 | Every delivery |
| 48186 | Pauls Farmhouse Gold Milk 1.5L | 3 | $3.61 | Every delivery |
| 70120 | Pauls Zymil Full Cream Milk 2L | 3 | $4.98 | Every delivery |
| 74930 | Pauls Zymil Low Fat Milk 2L | 3 | $4.98 | Most deliveries |
| 22444 | Pauls Zymil Full Cream Milk 6x1L | 4 | $2.90 | Every delivery |
| 16741 | Pauls Zymil Low Fat Milk 6X1L | 3 | $2.90 | Most deliveries |
| 30720 | Pauls Zymil Skim White Milk 6x1L | 2 | $2.90 | Most deliveries |
| 1003 | Pauls Full Cream Milk BTL 2L | 3 | $3.71 | Most deliveries |
| 5995 | Pauls Full Cream Milk CTN 1L | 6 | $2.41 | Most deliveries |
| 5987 | Pauls Full Cream CTN 600ML | 5 | $1.51 | Most deliveries |
| 851 | Rev Low Fat Milk CTN 1L | 3 | $2.46 | Most deliveries |
| 14584 | Physical Low Fat Milk CTN 1L | 4 | $2.46 | Most deliveries |
| 14592 | Physical Low Fat Milk 2L | 4 | $4.33 | Most deliveries |
| 47300 | Pauls Farmhouse Gold Milk 750ML | 4 | $2.12 | Most deliveries |
| 72019 | Pauls FHG Organic F/C 1.5L | 2 | $4.80 | Most deliveries |
| 46703 | Pauls Farmhouse Gold Unhomo Milk 1.5L | 2 | $3.61 | Some deliveries |
| 73483 | Pauls Protein Plus Low Fat Milk 2L | 2 | $4.94 | Some deliveries |
| 22608 | Pauls Low Fat Buttermilk 600ML | 3 | $2.35 | Some deliveries |
| 230410 | Pauls Zymil ESL Extra Creamy 1.5L | 2 | $3.92 | Occasional |
| 17099 | Pauls Full Cream Longlife 12X1L | 4 CTN | $31.17 | Occasional |

### FLAVOURED MILK — GST-bearing (10%), discounted pricing on invoices

| Item Number | Name | Avg Qty | Price/Unit | Frequency |
|------------|------|---------|-----------|-----------|
| 16110 | Ice Break Flav Milk Ice Coffee 750ML | 3 | ~$3.85 | Every delivery |
| 41339 | Ice Break Triple Shot Ice Coffee 750ML | 3 | ~$3.85 | Every delivery |
| 16010 | Ice Break Flav Milk Ice/Coff 500ML | 3 | ~$3.05 | Most deliveries |
| 41275 | Ice Break Triple Shot Ice Coffee 500ML | 3 | ~$3.05 | Most deliveries |
| 73079 | IB Strong Espresso Protein FM 500ML | 3 | ~$3.05 | Most deliveries |
| 73893 | OAK Flav Milk Chocolate 600ML | 2 | ~$2.95 | Every delivery |
| 73894 | OAK Flav Milk Strawberry 600ML | 3 | ~$2.95 | Every delivery |
| 73895 | OAK Flav Milk Iced Coffee 600ML | 2 | ~$2.95 | Every delivery |
| 70526 | OAK Plus FM No Sugar Added Choc 500ML | 3 | ~$3.22 | Most deliveries |
| 230150 | OAK Plus FM NAS Salted Caramel 500ML | 3 | ~$3.22 | Most deliveries |
| 230500 | OAK Peppermint Crisp FM 6X600ML | 3 | ~$2.95 | Most deliveries |
| 228500 | Pauls Plus Choc FM 6X400ML | 4 | ~$3.05 | Most deliveries |
| 228510 | Pauls Plus Banana Honey FM 6X400ML | 4 | ~$3.05 | Most deliveries |
| 230550 | Pauls Plus Espresso Caramel FM 400ML | 4 | ~$3.05 | Most deliveries |
| 230540 | Pauls Plus Summer Berries FM 400ML | 4 | ~$3.05 | Most deliveries |
| 60444 | Pauls Zymil Flav Milk Choc 6X400ML | 6 | ~$3.05 | Some deliveries |
| 73653 | OAK FM Chocolate Lactose Free 600ML | 3 | ~$2.95 | Some deliveries |
| 79060 | OAK FM Caramel Coffee 600ML | 3 | ~$2.95 | Some deliveries |
| 228180 | IB Strong Espresso Protein FM 750ML | 2 | ~$3.85 | Some deliveries |
| 61108 | OAK UHT Flav Milk Chocolate 6X500ML | 3 | ~$3.45 | Most deliveries |
| 61924 | OAK UHT Flav Milk Strawberry 6X500ML | 3 | ~$3.45 | Most deliveries |
| 61747 | OAK UHT Flav Milk Iced Coffee 6X500ML | 3 | ~$3.45 | Most deliveries |
| 73896 | OAK Flav Milk Vanilla Malt 600ML | 2 | ~$2.95 | Occasional |
| 34892 | OAK Flav Milk Banana 600ML | 2 | ~$2.95 | Occasional |
| 34868 | OAK Flav Milk Chocolate 300ML BTL | 3 | ~$1.97 | Occasional |
| 34964 | OAK Flav Milk Strawberry 300ML BTL | 3 | ~$1.97 | Occasional |
| 34390 | OAK Flav Milk Iced Coffee 300ML BTL | 3 | ~$1.97 | Occasional |

---

## Invoice Structure

Invoices are PDF, downloaded from Lactalis portal. Key fields per line item:
```
Product Description | Product Code (8-digit) | Quantity | EA/CTN | List Price | Line Disc. | Container Scheme | GST | Extended Price | Price Per Item
```

- **Use "Price Per Item" (last column) as the actual cost** — it's after all discounts
- Product Code on invoice with leading zeros stripped = Quick Order Item Number
- Invoices contain multiple Delivery Notes (2-3 per invoice) for different delivery dates
- Credit/Adjustment Notes exist for out-of-stock or driver errors — identified by "CR" in total and "Adjustment Note" or "Credit Adjustment Note" in header

## Smart Retail Data

Two export types, both .xlsx:

**Item Maintenance Report** (13 cols): Barcode, Description, Order Code, Supplier Code, Active, Normal Cost, Normal Sell, Current GP%, Normal GP%, Family, Department Code, Department Name, Commodity Name. Products appear in dual rows: Supplier 01240657 = Lactalis, Supplier 90770 = Metcash.

**Item Stock Report** (20 cols): Barcode, Description, Order Code, Supplier Name, ..., Carton Qty, ..., QOH, ... QOH data is unreliable (mostly negative). Use rate-of-change between snapshots for velocity.

## Key Design Decisions
1. **Invoice codes = Quick Order item numbers** (verified on live portal)
2. PWA over native iOS ($0, works on Windows too, owner has no Mac)
3. Chrome Extension for portal integration (not Playwright/Selenium)
4. IndexedDB via Dexie.js (browser-native, works offline)
5. Invoice-driven forecasting (not Smart Retail QOH which is broken)
6. PWA → Extension sync via QR code or CSV file download (no server needed)
7. Extension NEVER auto-submits orders — owner always clicks "Create Order"
8. All prices stored ex-GST. Margin calculations on consistent ex-GST basis.
9. All dates stored as YYYY-MM-DD strings (not Date objects) to avoid timezone bugs.
10. Money calculations use `Math.round(val * 100) / 100` to avoid floating point errors.

## File Conventions
- Components: PascalCase (`OrderBuilder.tsx`)
- Libs/utils: camelCase (`invoiceParser.ts`)
- Tests: `*.test.ts` / `*.test.tsx`
- Styling: Tailwind utility classes only, mobile-first
- Dates: always YYYY-MM-DD strings
- Money: always cents integer internally, display with `.toFixed(2)`
