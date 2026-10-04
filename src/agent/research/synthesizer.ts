/**
 * Deep Research Intelligence (additional capability — outside the numbered
 * roadmap) — final synthesis.
 *
 * Builds the structured report and its human-readable rendering from the
 * dossier. Honesty rules enforced here:
 *   - every factual statement cites its sources ([n] → citation list)
 *   - conflicts are reported side by side, never averaged away
 *   - single-source statements are labeled uncertain
 *   - statements not backed by a quote are labeled "inference"
 *   - unanswered sub-questions become open questions
 *   - confidence is derived from support counts, never inflated
 */
import type {
  Citation,
  ClaimVerdict,
  Evidence,
  ResearchDossier,
  ResearchReport,
  ReportFinding,
  ReportStatement,
  SourceConflict,
} from './researchTypes';
import { clampText } from './researchTypes';
import { rankSources } from './sourceComparator';

function confidenceFor(findings: ReportFinding[], conflicts: SourceConflict[]): 'high' | 'medium' | 'low' {
  const total = findings.length;
  if (total === 0) return 'low';
  const supported = findings.filter((f) => f.verdict === 'supported').length;
  const conflicting = findings.filter((f) => f.verdict === 'conflicting').length;
  const usable = findings.filter((f) => f.verdict === 'supported' || f.verdict === 'single_source').length;
  if (conflicting > supported) return 'low';
  // High confidence only when EVERY sub-question has independent multi-source
  // support — a single unanswered or single-source question caps it at medium.
  if (total > 0 && supported === total && supported >= 2 && conflicting === 0) return 'high';
  if (usable >= 1) return 'medium';
  return 'low';
}

function citationNumberFor(citations: Citation[], sourceId: string): number | undefined {
  return citations.find((c) => c.sourceId === sourceId)?.id;
}

export function buildReport(dossier: ResearchDossier): ResearchReport {
  const citations: Citation[] = dossier.sources.map((s, i) => ({
    id: i + 1,
    sourceId: s.id,
    title: s.title || s.domain || s.url,
    url: s.url,
    domain: s.domain,
    tier: s.tier,
    quality: s.quality,
  }));
  const citationBySource = new Map(citations.map((c) => [c.sourceId, c.id]));
  const evidenceById = new Map(dossier.evidence.map((e) => [e.id, e]));

  const findings: ReportFinding[] = [];
  const openQuestions: string[] = [];

  for (const assessment of dossier.assessments) {
    const sub = dossier.subQuestions.find((s) => s.id === assessment.subQuestionId);
    if (!sub) continue;
    const statements: ReportStatement[] = [];

    if (assessment.verdict === 'supported' || assessment.verdict === 'single_source') {
      const top = assessment.evidenceIds
        .map((id) => evidenceById.get(id))
        .filter((e): e is Evidence => Boolean(e))
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, assessment.verdict === 'supported' ? 3 : 2);
      for (const ev of top) {
        const citationId = citationBySource.get(ev.sourceId);
        if (citationId === undefined) continue;
        statements.push({
          text: ev.quote,
          citationIds: [citationId],
          kind: 'fact',
        });
      }
      if (assessment.verdict === 'single_source') {
        statements.push({
          text: 'This rests on a single source — treat as uncertain until independently confirmed.',
          citationIds: [],
          kind: 'inference',
        });
      }
    } else if (assessment.verdict === 'conflicting') {
      const conflict = dossier.conflicts.find((c) => c.subQuestionId === sub.id);
      if (conflict) {
        const idA = citationBySource.get(conflict.a.sourceId);
        const idB = citationBySource.get(conflict.b.sourceId);
        statements.push({
          text: `One source states: "${conflict.a.quote}"`,
          citationIds: idA ? [idA] : [],
          kind: 'fact',
        });
        statements.push({
          text: `Another source states: "${conflict.b.quote}"`,
          citationIds: idB ? [idB] : [],
          kind: 'fact',
        });
        statements.push({
          text: `These disagree (${conflict.detail}); I could not resolve which is correct from the inspected sources.`,
          citationIds: [],
          kind: 'inference',
        });
      }
    } else {
      openQuestions.push(`${sub.text} — no sufficient evidence found in this run`);
    }

    findings.push({ subQuestionId: sub.id, subQuestion: sub.text, verdict: assessment.verdict, statements });
  }

  // Unresolved conflicts whose sub-question got a verdict elsewhere still surface.
  const conflicts = dossier.conflicts;

  // Cross-question synthesis (clearly labeled inference, capped).
  const supportedFindings = findings.filter((f) => f.verdict === 'supported');
  const ranking = rankSources(dossier.sources, dossier.evidence);
  const limitations: string[] = [];
  if (dossier.failures.length > 0) {
    limitations.push(...dossier.failures.slice(0, 4).map((f) => clampText(f, 160)));
  }
  if (dossier.gaps.length > 0) {
    limitations.push('Research budget ended with open gaps — more rounds could add evidence.');
  }
  if (ranking.length > 0 && ranking.filter((r) => r.independent).length < 2) {
    limitations.push('Fewer than two independent domains were available — support is weak.');
  }
  limitations.push('Single-run web research with bounded depth; not a substitute for expert verification.');

  const answerParts: string[] = [];
  if (supportedFindings.length > 0) {
    const first = supportedFindings[0];
    const statement = first.statements.find((s) => s.kind === 'fact');
    if (statement) {
      const cite = statement.citationIds.map((id) => `[${id}]`).join('');
      answerParts.push(`${first.subQuestion.replace(/\?$/, '')}: ${clampText(statement.text, 240)}${cite}`);
    }
    if (supportedFindings.length > 1) {
      answerParts.push(`Supported findings cover ${supportedFindings.length} of ${findings.length} sub-questions.`);
    }
  } else {
    answerParts.push('I could not establish a well-supported answer from the sources inspected in this run.');
  }
  if (conflicts.length > 0) {
    answerParts.push(`Note: ${conflicts.length} conflict(s) between sources remain unresolved.`);
  }
  if (openQuestions.length > 0) {
    answerParts.push(`${openQuestions.length} sub-question(s) stayed open.`);
  }

  const confidence = confidenceFor(findings, conflicts);

  const report: ResearchReport = {
    question: dossier.question,
    answerSummary: answerParts.join(' '),
    confidence,
    findings,
    conflicts,
    openQuestions,
    citations,
    limitations: [...new Set(limitations)].slice(0, 6),
    stats: {
      rounds: dossier.roundsUsed,
      searches: dossier.searchesUsed,
      failedSearches: dossier.queries.filter((q) => q.status === 'failed').length,
      sourcesInspected: dossier.sources.length,
      failedFetches: dossier.failures.filter((f) => f.startsWith('fetch failed')).length,
      evidenceCount: dossier.evidence.length,
    },
    generatedAt: Date.now(),
  };
  return report;
}

/** Human-readable multi-line rendering with [n] citations (bounded). */
export function renderReport(report: ResearchReport, maxChars = 6_000): string {
  const lines: string[] = [];
  lines.push(`Research: ${report.question}`);
  lines.push('');
  lines.push(`Summary (${report.confidence} confidence): ${report.answerSummary}`);

  if (report.findings.length > 0) {
    lines.push('');
    lines.push('Findings:');
    report.findings.forEach((f, i) => {
      const label =
        f.verdict === 'supported'
          ? 'supported by multiple independent sources'
          : f.verdict === 'single_source'
            ? 'single source — uncertain'
            : f.verdict === 'conflicting'
              ? 'sources conflict'
              : 'not verified';
      lines.push(`${i + 1}. ${f.subQuestion} — ${label}`);
      for (const s of f.statements) {
        const cite = s.citationIds.length > 0 ? ` [${s.citationIds.join('][')}]` : '';
        lines.push(`   • ${s.text}${cite}`);
      }
    });
  }

  if (report.openQuestions.length > 0) {
    lines.push('');
    lines.push('Could not answer:');
    for (const q of report.openQuestions.slice(0, 5)) lines.push(`   • ${q}`);
  }

  if (report.limitations.length > 0) {
    lines.push('');
    lines.push('Limitations:');
    for (const l of report.limitations.slice(0, 4)) lines.push(`   • ${l}`);
  }

  if (report.citations.length > 0) {
    lines.push('');
    lines.push('Sources:');
    for (const c of report.citations.slice(0, 10)) {
      lines.push(`   [${c.id}] ${c.title} — ${c.domain} (${c.url})`);
    }
  }

  const text = lines.join('\n');
  return text.length <= maxChars ? text : text.slice(0, maxChars - 3).trimEnd() + '...';
}
