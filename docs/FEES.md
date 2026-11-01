# How fees work

Money is kept in whole paise. Nothing that has been charged or paid is ever edited or deleted: every change is a new line, so any rupee can be traced to the rule, version or decision that created it.

## Bills

What a family owes is grouped into **bills**, each with its own due date:

| Bill | Example | Comes from |
|---|---|---|
| Instalment | `Q3` (Oct–Dec), due 25 Oct | The fee plan: rates by class band and fee band, concessions by rule |
| Arrears | `REV2` (or `REV2-1`, `REV2-2` when spread) | A fee revision that reaches back to instalments already due or paid |
| Charge | `C:<id>`, "Science trip to Nehru Science Centre" | An additional charge raised by the school |

Parents pay any bills together; the server works out the amount, never the browser.

## Fee revisions (rates changed during the year)

1. The accountant drafts the new rate with an effective date (it may be in the past, for example "from 1 April" decided in October), a reason, and how to treat instalments already paid.
2. The preview shows the families affected, the extra demand and the arrears.
3. Someone else (principal or NES) approves. The new version is published and the differences are added, all in one transaction.

What happens to each instalment already raised from the effective date:

| Instalment | An increase | A reduction |
|---|---|---|
| Not yet due, not fully paid | Added to that instalment | Taken off that instalment |
| Already due (overdue) | Billed as **arrears**, with its own due date | Taken off that instalment |
| Already paid | Arrears, if the revision says "charge the difference on paid instalments" | Becomes a **credit** |

Arrears are due with the next instalment, by a chosen date, or spread over the remaining instalments. Every family is told the amount, the reason and the due date. Instalments not raised yet simply use the new rates. A version replaced from its first day is kept as *superseded*.

## Additional charges

For anything outside the fee plan: CBSE registration and board exam fees, trips, events, other items.

| | Compulsory | Optional |
|---|---|---|
| Example | CBSE registration, Classes IX and XI | Class VIII science trip |
| Who is charged | Every child in the chosen classes or sections, on approval | Only children whose parents say yes (in the app, or a paper slip recorded by the teacher in charge, class teacher or office) |
| Seats | | Optional limit; later "yes" replies go to a waiting list and move up automatically |
| Leaving | The principal can excuse a child, with a reason | Withdrawn by the refund date: charge reversed. After it: the charge stands |
| Cancelling | The principal cancels with a reason: every charge reversed, every payment adjusted or refunded | Same |

The accountant raises a charge; the principal approves it (two people). Once open, its amount and classes cannot change. Money collected for someone else (CBSE, a tour operator) is held as a liability (accounts 2300 and 2310) and paid out with a reference; it is never counted as school income. "Other charges" are income (4150).

New children joining the classes later are added with **Add new children**.

## Credits and refunds

A credit arises when a paid charge is reversed or a paid fee is reduced. The school chooses (setting *When a family has a credit*):

- **Use it for other dues** (default): it is moved to the family's oldest unpaid bills at the same school; anything left waits for the next instalment.
- **Refund it at once**.

Refunds that follow a rule (a cancelled trip, a withdrawal before the refund date) need no further approval. Any other refund goes through the approval chain (setting *Who approves refunds*). Money leaves only when the accountant records the transfer, cheque or cash voucher reference; the parent is told.

## Moving to another Navy school, and new admissions during the year

**Each school charges only for the time the child studied there, and no money passes between schools.**

- A quarter belongs to the school where the child was on its first day. The school the child leaves keeps the quarter in progress; the new school charges from its next quarter.
- Quarters the old school had already raised for later months are reversed there, and trips or events still to come are released (unless the school has already paid the money out, such as a CBSE registration sent to the board: that charge stands, and the new school does not charge it again).
- What the family had paid for what is reversed first clears anything else still owed at the old school; the rest is refunded by the old school (the refund is approved by rule and waits to be paid under Charges → Refunds).
- The new school sees every receipt from every Navy school on the child's record, and the month fees are paid up to. Open trips at the new school ask the parent like everyone else.
- The TC asks only for fees up to the leaving date; later quarters are not owed.

**New admissions:** a child joining during the year who was not at a Navy school before pays from the start of the academic year (the earlier quarters are billed at admission), or from the quarter of joining if the school's setting *A new admission during the year pays from* says so. Instalments are billed at admission as soon as the school has raised them for everyone.

## Ledger accounts used

| Account | Name |
|---|---|
| 1100 | Bank account |
| 1150, 1160 | Payment gateway clearing, cash in hand |
| 1200 | Fees receivable from students (per child) |
| 2100 | Fees received in advance |
| 2300 | CBSE fees collected, payable to CBSE |
| 2310 | Trip and event collections, payable |
| 4100–4150, 4190 | Tuition, annual, computer, transport, admission, other charges, late fee |
| 5100 | Fee concessions allowed |

## Not built yet

Late-fee rules, a counter-collection screen, concession requests, and matching bank settlement files.


## Monthly fees

- **A school can bill by the month.** Fees → Raise dues → *Bill by the month instead* (principal). The months not billed yet become twelve monthly bills (`M04` April … `M03` March), each a third of the quarterly rate to the rupee; annual charges go on the year's first bill; transport is charged per month used. Bills already raised stay. *Go back to quarterly bills* regroups the remaining months (a quarter already cut finishes month by month). Monthly bills are due on the day in the setting *Day of the month monthly fees are due* (default the 10th).
- **Parents may pay the whole year at once** (setting *Parents may pay the whole year at once*, on by default). The parent app shows *Pay for the whole year* with the total of the instalments not billed yet. Choosing it bills those instalments for that child now, each priced exactly as it would be later (same rates, concessions and fee band), so they appear with the other dues and are paid together. When the school later raises those instalments for everyone, this child is skipped: an instalment is billed once.
- **Parents may pay a quarter in monthly parts** (setting *Parents may pay a quarter in monthly parts*, on by default). The parent app offers *Pay October · ₹…* next to *Pay in full*: this month's share is a third of the quarter, less what is already paid towards the months so far. A part payment is at least ₹100 and goes to the fee heads in their usual order. The quarter's due date does not change.
