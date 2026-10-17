# Baseline: the Sheet's own figures

Read off the Apps Script portal's Control Tower, build **2026-10-16.3**, on **17 October
2026 at 20:25 IST**, combined stream.

These are what `migration/headline.js` is checked against. The screenshots themselves are
the record; this is a transcription for convenience, and where the two disagree the
screenshot wins.

## Headline

| | |
|---|---|
| Outstanding | ₹21.42 L |
| of which overdue | ₹20.11 L (94%) |
| Open order book | ₹10.67 L, 3 orders not yet closed |
| Invoiced this month (Oct) | ₹0.00, collected ₹0.00 |
| Weighted pipeline | ₹0.00 |
| Open quotations | 25, worth ₹11.58 L |

## Needs attention

| | count | value |
|---|---|---|
| Receivables over 90 days | 3 | ₹5.52 L |
| Orders past their promised date | 1 | ₹10.00 L |
| Quotations past their validity | 8 | — |

## Receivables ageing

| | |
|---|---|
| Not due | ₹1.31 L |
| 1–30 days | ₹6.40 L |
| 31–60 days | ₹5.01 L |
| 61–90 days | ₹3.18 L |
| 90+ days | ₹5.52 L |

## Order pipeline

Draft 2 (₹10.10 L) · Dispatched 1 (₹57K) · everything else nil.

## Invoiced against collected

| | May | Jun | Jul | Aug | Sep | Oct |
|---|---|---|---|---|---|---|
| Invoiced | ₹2.85 L | ₹4.70 L | ₹4.34 L | ₹8.13 L | ₹5.04 L | ₹0.00 |
| Collected | ₹85K | ₹0.00 | ₹60K | ₹1.20 L | ₹4.99 L | ₹0.00 |

## Who holds the money

Topworth Urja and Metals ₹3.45 L (147d) · Bharat Forge ₹3.31 L (110d) · Sandvik Asia
₹3.18 L (81d) · Kalyani Steels ₹2.49 L (103d) · Solar Industries ₹1.90 L (4d) · Indorama
Synthetics ₹1.75 L (49d) · Ceat Nagpur ₹1.50 L (59d) · Ultratech ₹1.28 L (36d) · Ashok
Iron Works ₹1.20 L (29d) · Vikram Auto ₹88K (23d).

## Spare enquiries

Quoted 1, Won 1. Nothing new or in identification. No open compressor opportunities.

---

## How to use this

**Not on cutover day.** PIE are still working in the Sheet, so by then these figures will
have moved and a difference will mean nothing. On the day, take a fresh screenshot
*immediately after the freeze* and compare against that.

**What it is good for now** is a free dry run. The deployed portal is running the
16 October export, and this is the Sheet a day later. Open both Control Towers side by
side:

- Figures that match → the export, the import and the portal's arithmetic all agree.
- Figures that differ → either PIE did that work in the Sheet after the export, which is
  expected and tells you how fast the data moves, or something is wrong and it is much
  better to find out now.

The headline is rounded to two decimals in lakhs, so treat anything under about ₹500 as
the same number.
