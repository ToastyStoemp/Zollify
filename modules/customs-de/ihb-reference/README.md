# IHB reference files

Extracted from the official ATLAS-EDI-IHB v10.2.8 (incl. AES-EDI-IHB v3.0.15),
downloaded 2026-09-21 from zoll.de → EDI-Implementierungshandbücher:
https://medien.zoll.bund.de/zoll/atlas/EDI-IHB_1028.zip (68 MB, full archive
not committed here - only the three files actually used).

- `DEXPDF.xsd` - the export declaration message schema (`E_EXP_DAT`).
  `dexpdf-xml.ts` is built directly against this file's element names and
  structure.
- `DEXPDF.csv` - the same message as a flat field list: path, restriction,
  structure, and validation regex (`Prüfmuster`) per field. Easier to grep
  than the XSD for "what does field X actually require".
- `Codeliste.xsd` - the shared codelist schema referenced throughout.

If ATLAS releases a newer IHB version, re-download and diff against these -
don't assume the schema hasn't changed.
