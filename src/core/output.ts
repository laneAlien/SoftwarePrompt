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

export function formatTextReport(report: ReportPayload): string {
  const lines: string[] = [];
  if (report.title) {
    lines.push(report.title);
  }
  report.sections.forEach((section) => {
    if (section.title) {
      lines.push('');
      lines.push(section.title);
    }
    Object.entries(section.rows).forEach(([key, value]) => {
      lines.push(`${key}: ${formatValue(value)}`);
    });
  });
  return lines.join('\n');
}

export function formatJsonReport(report: unknown): string {
  return JSON.stringify(report, null, 2);
}

export function formatMarkdownReport(report: ReportPayload): string {
  const lines: string[] = [];
  if (report.title) {
    lines.push(`# ${report.title}`);
  }
  report.sections.forEach((section) => {
    if (section.title) {
      lines.push('');
      lines.push(`## ${section.title}`);
    }
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    Object.entries(section.rows).forEach(([key, value]) => {
      const rendered = escapeMarkdown(formatValue(value));
      lines.push(`| ${escapeMarkdown(key)} | ${rendered} |`);
    });
  });
  return lines.join('\n');
}

export function printTextReport(report: ReportPayload): void {
  console.log(formatTextReport(report));
}

export function printJsonReport(report: unknown): void {
  console.log(formatJsonReport(report));
}

export function printMarkdownReport(report: ReportPayload): void {
  console.log(formatMarkdownReport(report));
}
