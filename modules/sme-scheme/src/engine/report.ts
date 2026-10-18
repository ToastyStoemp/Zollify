/**
 * The SME scheme's quarterly figures. The engine lives in @zollify/shared
 * (sme-report.ts) so core can use the same per-country turnover for the
 * threshold warnings on Home and in Settings → VAT; this file keeps the
 * module's own names for it.
 */
export {
  buildSmeReport,
  previousQuarter,
  quarterLabel,
  quarterOf,
  quarterRange,
  reportedCountries,
  schemeApplies,
  smeReportCsv as reportCsv,
  type CountryRow,
  type CsvHeader,
  type Quarter,
  type QuarterRef,
  type RateLine,
  type SmeReport,
  type SmeReportInput as ReportInput,
} from '@zollify/shared';
