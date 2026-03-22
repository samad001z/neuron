import jsPDF from "jspdf";
import "jspdf-autotable";

export type SecuritySummary = {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  score: number;
  repoName: string;
  fileCount: number;
  generatedAt: string;
};

export function generateSecurityReportPDF(report: string, summary: SecuritySummary): void {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;

  // Cover page
  doc.setFillColor(10, 10, 10);
  doc.rect(0, 0, pageWidth, 297, "F");

  // Title
  doc.setTextColor(237, 237, 237);
  doc.setFontSize(28);
  doc.setFont("helvetica", "bold");
  doc.text("Security Audit Report", margin, 60);

  // Repo name
  doc.setFontSize(14);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(136, 136, 136);
  doc.text(summary.repoName, margin, 75);

  // Generated date
  doc.setFontSize(10);
  doc.text(
    `Generated: ${new Date(summary.generatedAt).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "long",
      year: "numeric",
    })}`,
    margin,
    85,
  );
  doc.text(`Files analyzed: ${summary.fileCount}`, margin, 92);

  // Score box
  const scoreColor: [number, number, number] =
    summary.score >= 7 ? [34, 197, 94] : summary.score >= 4 ? [245, 158, 11] : [239, 68, 68];
  doc.setFillColor(...scoreColor);
  doc.roundedRect(margin, 110, 60, 40, 4, 4, "F");
  doc.setTextColor(10, 10, 10);
  doc.setFontSize(32);
  doc.setFont("helvetica", "bold");
  doc.text(`${summary.score}/10`, margin + 8, 136);
  doc.setFontSize(10);
  doc.text("Security Score", margin + 6, 145);

  // Severity breakdown table
  const severityData = [
    ["Critical", String(summary.critical), summary.critical > 0 ? "CRITICAL" : "OK"],
    ["High", String(summary.high), summary.high > 0 ? "HIGH" : "OK"],
    ["Medium", String(summary.medium), summary.medium > 0 ? "MEDIUM" : "OK"],
    ["Low", String(summary.low), summary.low > 0 ? "LOW" : "OK"],
  ];

  (doc as jsPDF & { autoTable: (options: unknown) => void }).autoTable({
    head: [["Severity", "Count", "Status"]],
    body: severityData,
    startY: 165,
    margin: { left: margin },
    styles: {
      fontSize: 11,
      cellPadding: 6,
      textColor: [237, 237, 237],
      fillColor: [26, 26, 26],
      lineColor: [34, 34, 34],
      lineWidth: 0.5,
    },
    headStyles: { fillColor: [17, 17, 17], fontStyle: "bold" },
  });

  // New page for full report
  doc.addPage();
  doc.setFillColor(10, 10, 10);
  doc.rect(0, 0, pageWidth, 297, "F");

  // Parse and render markdown report as text
  doc.setTextColor(237, 237, 237);
  doc.setFontSize(10);
  doc.setFont("courier", "normal");

  const lines = doc.splitTextToSize(report.replace(/#{1,3} /g, "").replace(/\*\*/g, ""), pageWidth - margin * 2);

  let y = 20;
  lines.forEach((line: string) => {
    if (y > 280) {
      doc.addPage();
      doc.setFillColor(10, 10, 10);
      doc.rect(0, 0, pageWidth, 297, "F");
      y = 20;
    }

    // Highlight vulnerability headers
    if (line.includes("CRITICAL")) doc.setTextColor(239, 68, 68);
    else if (line.includes("HIGH")) doc.setTextColor(245, 158, 11);
    else if (line.includes("MEDIUM")) doc.setTextColor(234, 179, 8);
    else if (line.includes("LOW")) doc.setTextColor(34, 197, 94);
    else doc.setTextColor(200, 200, 200);

    doc.text(line, margin, y);
    y += 5;
  });

  // Footer on each page
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.setTextColor(68, 68, 68);
    doc.setFontSize(8);
    doc.text(`Neuron Security Audit - ${summary.repoName} - Page ${i} of ${pageCount}`, margin, 292);
  }

  doc.save(`security-audit-${summary.repoName.replace("/", "-")}-${Date.now()}.pdf`);
}
