# AUDIT.md — Self-Check: Problems, Fees, Dependencies & Risks

## ✅ RESOLVED SHOWSTOPPER — Invoice Codes ARE Quick Order Item Numbers

### 0. Invoice Product Codes vs Portal SKU Numbers
**RESOLVED on 13 March 2026**: Owner tested on live portal. Typing `801` (invoice code stripped of leading zeros) → finds "Pauls Milk Rev Low Fat 2L" ✅. Typing `807` (portal Favourites display SKU) → nothing found ❌. **Portal Favourites "SKU" numbers are display-only. Invoice codes are the real ordering codes.**

Original concern (now resolved) — cross-checking showed different numbering:

| Product | Portal SKU | Invoice Code (stripped) | Match? |
|---------|-----------|------------------------|--------|
| Rev Low Fat Milk 2L | 807 | 801 | ❌ |
| Full Cream Milk BTL 2L | 70032 | 1003 | ❌ |
| Mooloo Mountain F/CRM 2L | 79100 | 19100 | ❌ |
| OAK Chocolate 600ml | 73803 | 73893 | ❌ |
| OAK Strawberry 600ml | 73804 | 73894 | ❌ |
| Ice Break Regular 500ml | 18010 | 16010 | ❌ |
| Farmhouse Gold 1.5L | 48186 | 48186 | ✅ |
| PhysiCAL 1L LOW FAT | 14584 | 14584 | ✅ Maybe |

**Impact**: If we generate a CSV with invoice codes and upload to Quick Order, it will order the WRONG products or fail entirely.

**Resolution (owner must do before coding starts)**:
1. Go to Lactalis Quick Order → type `801` in Item # field. Does it find Rev Low Fat Milk 2L?
2. Try `807` in the same field. Which one works?
3. Download the CSV template from the "What File Structure Is Accepted" link
4. Upload a test CSV with 2-3 items using invoice codes → click "Verify Order" (not "Create Order")
5. If wrong products appear, try again with portal SKUs from Favourites page

**Design fix**: Store BOTH codes as separate fields: `invoiceCode` and `portalSku`. Use `portalSku` for ordering, `invoiceCode` for invoice matching. Build a mapping verification screen in the app.

---

## 🔴 CRITICAL ISSUES (Will break the project if not addressed)

### 1. PDF Parsing in Browser — No Library Included
**Problem**: The plan says "PDF text extraction via PDF.js" but PDF.js extracts raw text from PDFs with NO guaranteed formatting. Lactalis invoices are structured PDFs with table layouts — PDF.js will return jumbled text where columns merge and line items become unreadable.
**Impact**: Invoice parser will fail on most invoices.
**Fix options**:
- Option A: Use `pdf-parse` (Node.js) or `pdfjs-dist` with careful position-aware text extraction
- Option B: Skip in-browser PDF parsing entirely. Instead, use the invoice text that Claude already extracted (we have all 16 invoices parsed). Build the parser to work on the STRUCTURED TEXT output, not raw PDF
- Option C: Use a pre-processing step — Python script on Windows PC to convert PDF → structured CSV before import
- **Recommended**: Option B for MVP (manual paste of invoice text or use a desktop Python script), upgrade to Option A later. Add `pdfjs-dist` to dependencies.

### 2. IndexedDB Storage Limits
**Problem**: Plan says "all data on-device in IndexedDB" but doesn't address storage quotas.
**Impact**: Safari on iOS limits IndexedDB to ~50MB before prompting user. If the PWA isn't added to home screen, Safari may evict data after 7 days of non-use.
**Fix**: 
- Ensure PWA is added to Home Screen (persistent storage)
- Call `navigator.storage.persist()` on first load to request persistent storage
- Monitor usage with `navigator.storage.estimate()`
- Implement regular JSON backup/export as safety net
- For 45 SKUs × 3 years of data, we're looking at <5MB — well within limits. But log the warning.

### 3. PWA ↔ Chrome Extension Communication Gap
**Problem**: Plan proposes "Google Drive API or Cloudflare KV" for syncing orders from phone PWA to PC Chrome Extension. But:
- Google Drive API requires OAuth2 setup + API key ($0 but complex)
- Cloudflare KV requires a Cloudflare account + Worker ($0 on free tier but setup overhead)
- Neither is truly "zero setup"
**Impact**: The most important integration (phone → PC) has no simple solution.
**Fix options**:
- Option A: **QR Code** — PWA generates QR code with the order data (45 items × qty = ~200 bytes easily fits in a QR code). Scan with PC webcam or phone camera. Zero infrastructure.
- Option B: **Simple JSON paste** — PWA copies order JSON to clipboard, owner emails/messages it to themselves, pastes into extension popup
- Option C: **Shared clipboard** — If using Chrome on both phone and PC with same Google account, clipboard sync works natively
- Option D: **Local file** — PWA downloads a .csv file, owner transfers via cloud storage they already use (Google Drive, iCloud, etc.)
- **Recommended**: Start with Option A (QR code) + Option D (file download). No infrastructure needed.

### 4. Chrome Extension Manifest V3 — Service Worker Limitations
**Problem**: Manifest V3 service workers are NOT persistent — they go idle after 30 seconds of inactivity and are terminated after 5 minutes. The plan's background.js polling for new orders won't work as written.
**Impact**: Extension won't reliably detect new orders or maintain state.
**Fix**: 
- Don't rely on background polling. Instead, use the popup to manually trigger order upload
- Store pending orders in `chrome.storage.local` (persists across service worker restarts)
- Content script checks for pending orders when the Lactalis page loads (not via background)

### 5. Content Script Injection — Lactalis Portal May Block
**Problem**: The Lactalis portal may use Content Security Policy (CSP) headers that block injected scripts. Some e-commerce platforms actively prevent extension manipulation.
**Impact**: Auto-fill functionality may not work at all.
**Fix**:
- Test on the actual portal FIRST before building elaborate auto-fill
- If CSP blocks injection, fall back to clipboard paste (user manually pastes into the textarea)
- The paste box already exists on the Quick Order page — worst case, copy to clipboard is still 90% of the value
- Add `"world": "MAIN"` to content script config if needed for DOM access

---

## 🟡 SIGNIFICANT ISSUES (Will cause pain if not addressed)

### 6. Lactalis Product Code Mapping — Not 1:1 With Portal SKU
**Problem**: Invoice uses 8-digit codes like `00019100`. Portal screenshots show SKUs like `19100`, `807`, `5987`. The plan says "strip leading zeros" but there's a subtle issue:
- Invoice code `00000801` → stripped = `801` 
- But portal screenshot shows the product as **SKU 807** (REV MILK R/FAT 2L)
- Invoice code `00001003` → stripped = `1003`
- But portal screenshot lists **Pauls Milk Full Cream 2L** under different-looking number
**Impact**: Some SKU mappings may be WRONG. The invoice code and portal SKU might not be the same number for all products.
**Fix**: 
- Cross-validate EVERY product: invoice code (stripped) vs portal Favourites SKU
- The owner needs to verify the first order generated by the system matches what the portal expects
- Build a "test order" feature that generates a small CSV (2-3 items), uploads to portal via Quick Order → Verify Order (without submitting), and checks if the right products appear
- Store both `invoiceCode` and `portalSku` as separate fields, with a `verified` flag

### 7. No Offline-First Strategy for Service Worker
**Problem**: Plan mentions "Service Worker + Workbox" for offline but doesn't include it in package.json or implementation details.
**Impact**: PWA won't work offline, which defeats a key advantage.
**Fix**: 
- Add `vite-plugin-pwa` (already in package.json — good)
- Configure Workbox with precaching for app shell + runtime caching for data
- Test offline mode explicitly: airplane mode → open app → verify data loads from IndexedDB

### 8. Date Parsing Inconsistency
**Problem**: Invoices use DD.MM.YYYY format (Australian/European). JavaScript `Date` constructor expects different formats. Multiple date formats in play:
- Invoice dates: `05.01.2026` (DD.MM.YYYY)
- Delivery note dates: `5.1.2026` (D.M.YYYY — no leading zeros!)
- Smart Retail: unknown format
- ISO format: `2026-01-05` (what we should store)
**Impact**: Date parsing bugs will cause orders to appear on wrong dates, forecasts to miscalculate.
**Fix**: 
- Use `date-fns` (already in dependencies — good) with `parse()` function and explicit format strings
- Normalize ALL dates to ISO format (YYYY-MM-DD) on import
- Never rely on `new Date(string)` — always use explicit parsing
- Add format detection: if string contains `.` → DD.MM.YYYY, if `/` → DD/MM/YYYY

### 9. No Data Backup Beyond Manual Export
**Problem**: All data is in IndexedDB on a single device. Phone reset, browser clear, or accidental "Clear browsing data" = total data loss.
**Impact**: Months of order history, product settings, and price tracking gone.
**Fix**:
- Auto-export JSON backup weekly (prompt user to save to Files/Drive)
- Also export on every significant action (order approved, invoice imported)
- Store backup in multiple locations: IndexedDB + `localStorage` (redundant) + downloadable file
- Consider: add a simple "email backup to yourself" button

### 10. Flavoured Milk GST Handling
**Problem**: Plan tracks `isGstBearing` but doesn't clarify how this affects cost comparison with Metcash.
- Lactalis invoice shows Price Per Item EXCLUDING GST for GST-bearing items
- Smart Retail's "Normal Cost" — is this including or excluding GST?
- Margin calculations need to be on the same basis (both ex-GST or both inc-GST)
**Impact**: Margin calculations may be wrong by 10% for all flavoured milk products.
**Fix**:
- Verify with the owner: does Smart Retail show cost prices ex-GST or inc-GST?
- Add a `gstInclusive` flag to price sources
- Ensure all margin calculations use consistent basis (recommend ex-GST everywhere, add GST only for customer-facing totals)

---

## 🟢 MINOR ISSUES (Nice to fix but won't block progress)

### 11. XLSX Parsing Not Included
**Problem**: Smart Retail exports are .xlsx files. PapaParse handles CSV but NOT Excel files.
**Impact**: Import won't work with the actual .xlsx files the owner exports.
**Fix**: Add `xlsx` (SheetJS) to dependencies: `npm install xlsx`. Use it to convert .xlsx → JSON before processing. Alternatively, the owner can save-as CSV from Excel before importing.

### 12. No Error Logging or Crash Reporting
**Problem**: No mechanism to capture errors in production. If the invoice parser fails on a particular PDF format, the owner won't know why.
**Fix**: 
- Add try-catch with user-friendly error messages on every import/parse action
- Store errors in an `ErrorLog` IndexedDB table with timestamp, action, error message
- Show error history in Settings for debugging

### 13. Barcode Scanner Library
**Problem**: `html5-qrcode` is listed for barcode scanning but isn't in package.json.
**Fix**: Add to dependencies when building the barcode scanner feature (Phase 6). Not needed for MVP.

### 14. No Versioning for Database Schema
**Problem**: Dexie supports schema versioning for migrations, but it's not planned.
**Impact**: If we change the schema after the owner has data, we need a migration path.
**Fix**: Start with Dexie version 1. Document schema version. Use Dexie's `.upgrade()` for any future changes.

---

## 💰 COST AUDIT — Hidden Fees & Required Programs

### Confirmed $0 Items
| Item | Status | Notes |
|------|--------|-------|
| React, Vite, TypeScript | Free | MIT licensed |
| Tailwind CSS | Free | MIT licensed |
| Dexie.js | Free | Apache 2.0 |
| PapaParse | Free | MIT licensed |
| Recharts | Free | MIT licensed |
| GitHub Pages hosting | Free | Unlimited for public repos |
| Cloudflare Pages hosting | Free | Free tier: 500 builds/month |
| Chrome Extension | Free | No fee to sideload in developer mode |
| Chrome browser | Free | Already installed |

### Potential Costs
| Item | Cost | When | Avoidable? |
|------|------|------|-----------|
| **GitHub account** | $0 (free tier) | Project start | No — needed for hosting + version control |
| **Node.js** | $0 | Project start | No — needed for build tooling |
| **VS Code** | $0 | Project start | No — needed for development |
| **Chrome Web Store** (if publishing extension) | $5 USD one-time | Only if distributing publicly | Yes — sideloading is free |
| **Custom domain** (optional) | ~$15/year | Only if wanted | Yes — GitHub Pages URL is fine |
| **Google Drive API** (if using for sync) | $0 | Only if chosen for PWA↔Extension sync | Yes — use QR code or file transfer instead |
| **Anthropic API** (Claude Code) | Usage-based | During development | Depends on plan — free tier may suffice |
| **SSL certificate** | $0 | Automatic via GitHub Pages/Cloudflare | N/A — handled by hosting |

### Required Software on Windows PC
| Software | Required For | Free? | Download |
|----------|-------------|-------|----------|
| **Node.js 18+** | Build tooling, npm | Yes | nodejs.org |
| **VS Code** | Code editor | Yes | code.visualstudio.com |
| **Git** | Version control, deployment | Yes | git-scm.com |
| **Chrome** | Extension development + Lactalis portal | Yes | Already installed |
| **Python 3** (optional) | PDF pre-processing script | Yes | python.org |

### Required Accounts
| Account | Required For | Free? |
|---------|-------------|-------|
| **GitHub** | Hosting PWA, version control | Yes (free tier) |
| **Google account** | Chrome sync (optional), Google Drive (optional) | Yes — likely already has one |

**Total minimum cost: $0**
**Total maximum cost: $5 USD (Chrome Web Store fee, only if publishing extension publicly)**

---

## 🔄 WORKFLOW GAPS

### Gap 1: First-Time Setup Complexity
**Problem**: The owner is comfortable with code and APIs, but the initial setup requires:
1. Install Node.js
2. Install Git
3. Clone repo
4. npm install
5. npm run build
6. Deploy to GitHub Pages
7. Load Chrome extension
8. Seed product data
That's a lot of steps before anything works.
**Fix**: 
- Write a `setup.bat` (Windows batch script) that automates steps 1-6
- Or: build the PWA first as a single HTML file that works without any build step (like the prototype we already built)
- Prioritise getting the MVP working on Day 1

### Gap 2: Smart Retail Export Automation
**Problem**: The plan relies on manual CSV export from Smart Retail, but doesn't address how often or how painful this is.
**Fix**: Ask the owner:
- Can Smart Retail schedule automatic email reports?
- Can it export to a shared folder?
- Is there a Smart Retail API? (unlikely for smaller POS systems)
- If manual, add a reminder notification in the PWA: "Time to export Smart Retail data"

### Gap 3: What Happens When Lactalis Portal Changes
**Problem**: The Chrome extension's content scripts depend on the portal's DOM structure. When Lactalis updates their website, selectors break.
**Fix**:
- Use resilient selectors (multiple strategies, text-based matching, not just CSS classes)
- Add a "manual mode" fallback: extension generates the paste string, copies to clipboard, shows instructions
- Version the selector config so it can be updated without rebuilding the whole extension

### Gap 4: Order Verification Before Submit
**Problem**: The plan says "extension auto-fills Quick Order, owner clicks Create Order." But what if the portal shows different prices or products than expected?
**Fix**:
- After auto-fill + Verify Order, the extension should scrape the verification results
- Compare: expected products/prices vs what the portal shows
- Highlight any discrepancies in the extension popup
- Show a clear "Looks good" or "⚠️ 3 items differ" message

### Gap 5: No Handling of New Products
**Problem**: When a new product is added to the range (or an existing one is discontinued), the system doesn't know.
**Fix**:
- Invoice parser should flag unknown product codes: "New product detected: 00099999 — PAULS NEW PRODUCT 1L"
- Dashboard alert: "2 new products found in latest invoice — add to catalogue?"
- Product list should have an "Add Product" flow with barcode scanner option

### Gap 6: No Multi-Device Consideration
**Problem**: If the owner uses the PWA on both phone AND PC browser, they'll have separate IndexedDB databases with diverging data.
**Fix**:
- Acknowledge this is a single-device tool (phone is primary)
- PC browser is used for the Chrome extension only, not the PWA
- If they do use PWA on PC, implement the backup/restore mechanism as the "sync" path

---

## 🐛 POTENTIAL BUGS

### Bug 1: Leading Zero Stripping Edge Cases
```javascript
"00000801".replace(/^0+/, "") // Returns "801" ✓
"00000000".replace(/^0+/, "") // Returns "" ✗ — should return "0"
```
**Fix**: Use `parseInt(code, 10).toString()` or add fallback: `stripped || "0"`

### Bug 2: Floating Point Arithmetic in Price Calculations
```javascript
2.41 * 6  // Returns 14.459999999999999 — not 14.46
```
**Impact**: Order totals will show wrong cents, margin calculations will drift.
**Fix**: Use integer arithmetic (store prices in cents) or `toFixed(2)` on every calculation. Better: use a helper function `money(val) => Math.round(val * 100) / 100`.

### Bug 3: CSV Generation — Comma in Product Name
If a product name contains commas and the CSV includes product names (for debugging), the CSV will break.
**Fix**: The Lactalis CSV only needs SKU + qty (no names), so this shouldn't affect ordering. But for any CSV export that includes names, wrap in quotes.

### Bug 4: Service Worker Cache Stale Data
After an app update, the service worker may serve cached old version.
**Fix**: Implement cache-busting versioning. Workbox handles this via `vite-plugin-pwa` config.

### Bug 5: IndexedDB Transaction Conflicts
Dexie handles most transaction conflicts, but bulk imports (100+ rows) may hit performance issues on older phones.
**Fix**: Use Dexie's `bulkPut()` instead of individual `put()` calls. Show progress indicator during imports.

### Bug 6: Time Zone Issues
**Problem**: The owner is in Melbourne (AEST/AEDT, UTC+10/+11). Order cutoffs are in local time. If dates are stored as UTC without timezone awareness:
- "Order before 17/03 at 1:00pm AEST" could be miscalculated
**Fix**: Store all dates as date strings (YYYY-MM-DD) not timestamps. Store times as local time strings (HH:MM). Don't convert to UTC. Melbourne timezone is the only timezone that matters.

### Bug 7: Duplicate Invoice Import
If the owner imports the same invoice PDF twice, it'll create duplicate records.
**Fix**: Check `documentNumber` uniqueness before saving. Show "This invoice has already been imported" with option to re-import (overwrite).

---

## ✅ RECOMMENDED CHANGES TO PLAN

1. **Add `xlsx` (SheetJS) to dependencies** — needed for Smart Retail .xlsx files
2. **Add `pdfjs-dist` to dependencies** — needed for invoice PDF parsing in browser
3. **Replace PWA↔Extension sync with QR code approach** — zero infrastructure
4. **Add `navigator.storage.persist()` call** — prevent Safari data eviction
5. **Add money helper function** — prevent floating point bugs everywhere
6. **Add schema versioning** — Dexie version 1 from the start
7. **Cross-validate first 5 SKU codes** — verify invoice code = portal SKU before building full automation
8. **Add "manual mode" fallback for extension** — clipboard copy when auto-fill fails
9. **Store dates as strings not Date objects** — avoid timezone bugs
10. **Add duplicate detection on all imports** — invoice, CSV, stock report
