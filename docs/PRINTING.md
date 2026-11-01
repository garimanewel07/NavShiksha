# Printing: library labels, ID cards and certificates

Everything the school prints is made as a PDF at the exact paper size, in millimetres. Print it at **Actual size (100%)**, never "Fit to page". Each printer is calibrated once, so prints line up with the school's own printer and stationery.

## Printers and calibration (Printing screen)

1. Add each printer the school uses: the office laser (certificates), the label printer (library), the card printer (ID cards).
2. Print its calibration page on the paper it uses.
   - A4: a vertical line 20 mm from the left edge, a horizontal line 20 mm from the top, and a 150 mm ruler line.
   - Card: a frame 2 mm inside every edge.
   - Labels: a box 1 mm inside every label.
3. Measure with a ruler. If a line is 22 mm instead of 20 mm, enter −2 (moves left); 18 mm, enter +2. If the 150 mm line measures 148.5 mm, enter scale 101%.
4. Save and print again to check. Every later print for that printer carries the correction.

## Stationery

Ready for every school: A4 label sheets with 65, 40, 24 and 21 labels (Avery L7651, L7654, L7159, L7160 layouts) and thermal roll labels of 50 × 25 mm and 38 × 25 mm. A school adds any other stationery by measuring it: page size, labels or cards across and down, their size, margins and gaps. This covers other label sheets, pre-cut PVC card sheets and inkjet card trays.

## Library labels

- New copies get the next accession number and a barcode made from it (for example `MB000123`). A label carries the school, the call number, the barcode, the accession number and the title.
- Print every copy without a label yet, or reprint a range of accession numbers. On a part-used sheet, start at the first free label.
- Barcodes are Code 128 with quiet zones; if a label is too narrow to scan reliably, the system refuses rather than printing labels that will not scan.

## Bringing the old ERP's library across

1. **Book list:** export it from the old system as CSV and upload it under Library → Import from old ERP. Columns are matched by name (Acc No, Accession Number, QR Code, Book Id, Title, Author, ISBN, Call No, Price, Rack, Date of Accession, Status…) and can be changed by hand. The preview lists every problem before anything is saved; the import is all or nothing.
2. Each copy keeps its **accession number** and the **code already on its label**, whether a barcode or QR text, a number or a link. Scanning an old label works straight away; nothing is relabelled. Copies with no code get a new barcode label. New books continue the accession register after the highest imported number.
3. **Books on loan:** upload a second CSV with the borrower (admission number, NES ID or staff number), the book (label code or accession number), the issue date and the due date.

## ID cards

- **Card stock:** CR80 (85.6 × 54 mm, the standard plastic PVC card), CR79 (84 × 52 mm, adhesive-backed) or a custom size; portrait or landscape. Designs are drawn for CR80 and scaled exactly to other sizes.
- **Printing on:** a PVC card printer (one card per page at the card's size), plain A4 with crop marks, or a school-defined sheet or tray. On A4, back pages are mirrored so double-sided printing (flip on the long edge) puts each back behind its front.
- **Front:** school name and address band, photo, name, class (or designation), admission number, date of birth, blood group, house, a barcode with the NES ID (staff: `ST-` and the staff number) for the library desk and the gate, and the validity date.
- **Back:** "In an emergency" with the parent's name and phone (staff: their emergency contact), the return address, and the principal's signature.
- **Validity:** "End of the academic year" by default, so cards printed after the change of year are right without editing the design.
- **Who has a card:** every print is recorded against the person and the academic year. New admissions and new staff during the year appear as "without a card", and at the change of year everyone does; print "only those without a card this year".
- **Photos:** upload many at once, each file named with the admission number (or staff number). Class teachers can add photos for their own class. People without a photo print with a clear "Photo" box so gaps are noticed.
- **Staff details:** staff numbers, blood group, phone and dates, typed in or imported from a spreadsheet.

## Certificates

| Certificate | Serial | Notes |
|---|---|---|
| Transfer certificate (TC) | TC/2026-27/0001 | CBSE fields in order. Needs fees up to the leaving date paid and library books returned (a school setting). Approved by the class teacher, then the principal. Leaving the Navy schools: ends the enrolment on the leaving date and refunds anything paid for later quarters. Going to another Navy school: only once that school has accepted the child; on issue the child moves into the promised seat the next day. |
| Bonafide | BC/… | For passports, bank accounts, scholarships. |
| Character | CC/… | |
| Study | SC/… | Years and classes studied. |
| Fee paid | FC/… | Tuition shown separately for the income-tax deduction. |
| CEA (Children Education Allowance) | CEA/… | The Navy consolidated format: every NES school the child attended in the academic year (1.1, 1.2), with affiliation, class, roll number, admission number and curriculum; reference, date, place; the MoD / DoP&T / IHQ MoD (N) authority line (an NES setting). |

- **Flow:** a parent requests in the app, or the office starts one. The office prepares it from the records; every printed field can be checked and corrected. It goes through the school's approval chain, or is issued at once when the principal submits it.
- **A whole class at once:** CEA and bonafide drafts for chosen classes, issued together by the principal and printed in one PDF.
- **Paper:** plain A4 with the school heading (logo, name, address, contact, board, affiliation, UDISE, school number), or pre-printed letterhead with the top left blank (a school setting with the space in millimetres).
- **Copies:** the first office print is the original; later prints say "Duplicate copy"; a parent's download says "Digital copy"; a draft says "Draft – not valid".
- **Downloading many at once:** Certificates → Download: every issued certificate, or one kind (for example every TC), for a class, an academic year, this week, this month, last month or any dates, as one PDF with a register page in front (marked "Office copy", not counted as printed copies), or the register as a spreadsheet.
- **Checking:** every issued certificate has a QR code and a code that open a public page showing whether it is genuine, with its details. A mistake is cancelled (the check page then says so) and a new one issued; an issued certificate is never edited.
- **Emblems:** every certificate carries the school's emblem on the left and the Navy Education Society's on the right, with the school name centred between them; ID cards carry both in the coloured band. Until a school uploads its own logo, Navy Children Schools use the official NCS emblem and Navy Kindergartens the NES emblem (both from nesnavy.in, in `server/src/reference/brand/`).
- **School images:** logo, principal's signature and school stamp (Printing → School images; signature and stamp by the principal only).
- **Digital signature:** signing PDFs with the principal's DSC token is planned for production (R7).
