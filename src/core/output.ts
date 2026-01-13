export type OutputFormat = 'text' | 'json' | 'md';

export type ReportValue = string | number | boolean | null;

export interface ReportSection {
  title: string;
  rows: Record<string, ReportValue>;
}

export interface ReportPayload {
  title?: string;
  sections: ReportSection[];
}

function formatValue(value: ReportValue): string {
  if (value === null || value === undefined) {
    return 'n/a';
  }
  return String(value);
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br />');
}

export function printTextReport(report: ReportPayload): void {
  if (report.title) {
    console.log(report.title);
  }
  report.sections.forEach((section) => {
    if (section.title) {
      console.log(`\n${section.title}`);
    }
    Object.entries(section.rows).forEach(([key, value]) => {
      console.log(`${key}: ${formatValue(value)}`);
    });
  });
}

export function printJsonReport(report: unknown): void {
  console.log(JSON.stringify(report, null, 2));
}

export function printMarkdownReport(report: ReportPayload): void {
  if (report.title) {
    console.log(`# ${report.title}`);
  }
  report.sections.forEach((section) => {
    if (section.title) {
      console.log(`\n## ${section.title}`);
    }
    console.log('| Metric | Value |');
    console.log('| --- | --- |');
    Object.entries(section.rows).forEach(([key, value]) => {
      const rendered = escapeMarkdown(formatValue(value));
      console.log(`| ${escapeMarkdown(key)} | ${rendered} |`);
    });
  });
}
