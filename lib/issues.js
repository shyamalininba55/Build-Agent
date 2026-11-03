const ISSUE_RULES = [
  { category: "Security", pattern: /(?:exposed|leaked|hardcoded)\s+(?:secret|credential|api\s*key|token)|secret.{0,30}(?:expos|leak|commit)|\bSSRF\b|unsafe command|command injection|(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{20,}["']|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA|EC|OPENSSH|DSA) PRIVATE KEY-----/i },
  { category: "Rollback", pattern: /rollback.{0,40}(?:failed|unavailable)|previous version.{0,30}unavailable/i },
  { category: "Pipeline", pattern: /pipeline (?:stopped|failed)|stage failed|previous stage dependency|stage dependency failed/i },
  { category: "GitHub", pattern: /github|pull request|repository not found|insufficient permissions|remote: Permission to .+ denied/i },
  { category: "Database", pattern: /database|postgres|postgresql|mysql|migration|\bSQL\b.{0,30}(?:error|failed)|connection.{0,30}(?:database|postgres|mysql)/i },
  { category: "Deployment", pattern: /render deploy|deployment|deploy hook|service unavailable.{0,30}render|render.{0,30}(?:failed|timeout|unavailable)/i },
  { category: "Git", pattern: /git (?:not found|not installed)|authentication failed|push rejected|non-fast-forward|merge conflict|branch conflict|failed to push|could not read from remote/i },
  { category: "API", pattern: /(?:api[_ -]?key).{0,40}(?:missing|not set|not configured|invalid|not valid|expired|unauthorized)|(?:invalid|expired|unauthorized).{0,40}(?:api[_ -]?key|credentials|token)|(?:quota exceeded|rate limit|model unavailable|API timeout|HTTP\s*(?:401|403|429)|\b(?:401|403|429)\b|API error\s*[45]\d\d|authentication method|invalid credentials|expired token)|(?:Anthropic|Google AI|OpenAI|Gemini|Claude).{0,80}(?:API error|quota|timeout|timed out|unavailable|authentication|unauthorized|invalid|expired|not configured|not set)/i },
  { category: "Network", pattern: /DNS|ENOTFOUND|(?:ERR_)?ECONNREFUSED|ERR_CONNECTION_REFUSED|ECONNRESET|ETIMEDOUT|network timeout|connection refused|socket hang up|fetch failed|HTTP\s+[45]\d\d|getaddrinfo failed|NewConnectionError|failed to establish a new connection|temporary failure in name resolution|name or service not known|winerror\s+11001/i },
  { category: "Dependency", pattern: /npm (?:install|ci)|pip install|pub get|package.{0,30}(?:missing|not found|conflict)|dependency.{0,30}(?:failed|conflict|missing)|ModuleNotFoundError|Cannot find module|ERR_MODULE_NOT_FOUND|No matching distribution found/i },
  { category: "Testing", pattern: /(?:unit|integration|flutter)?\s*tests?\s+(?:failed|timed out|timeout|ETIMEDOUT)|test.{0,80}(?:timeout|timed out|ETIMEDOUT)|AssertionError|test suite failed|jest.*failed|pytest.*failed/i },
  { category: "CMD/Terminal", pattern: /command not found|not recognized as an internal or external command|wrong working directory|permission denied|invalid command|process exited with code/i },
  { category: "Environment", pattern: /unsupported engine|requires node|wrong (?:node|python|java) version|missing (?:environment variable|SDK|toolchain)|(?:environment variable|env var).{0,40}(?:missing|not set|undefined)|(?:python|flutter|java|node).{0,30}(?:not installed|not available|missing SDK)|not installed or not available on PATH|JAVA_HOME|ANDROID_HOME/i },
  { category: "File/project", pattern: /file not found|no such file or directory|invalid project structure|corrupted configuration|EACCES|ENOTDIR/i },
  { category: "AI-agent", pattern: /AI (?:provider|agent)|agent response|model response|agent returned empty|empty (?:file )?content|empty AI response|could not parse file selection|repair attempt|wrong file modification|incomplete implementation/i },
  { category: "Coding", pattern: /SyntaxError|syntax error|ReferenceError|undefined variable|is not defined|TypeError|type error|unexpected token|import error|wrong function|is not a function|invalid generated code/i },
  { category: "Build", pattern: /build failed|build error|compilation error|compile error|missing asset|flutter.{0,40}android.{0,40}build/i },
  { category: "Pipeline", pattern: /pipeline timed out|pipeline stage timed out/i }
];

const REPAIRABLE_CATEGORIES = new Set([
  "Coding",
  "Dependency",
  "Testing",
  "Build",
  "File/project",
  "AI-agent"
]);

export function classifyIssue(error, stage = "") {
  const message = String(error || "");
  const combined = `${stage}\n${message}`;
  const rule = ISSUE_RULES.find((candidate) => candidate.pattern.test(combined));
  if (!rule) return { category: "Pipeline", retryable: false };
  return {
    category: rule.category,
    retryable: REPAIRABLE_CATEGORIES.has(rule.category)
  };
}

export function isRepairableIssue(issue) {
  return Boolean(issue?.retryable && REPAIRABLE_CATEGORIES.has(issue.category));
}

export function sanitizeDiagnostic(text) {
  return String(text || "")
    .replace(/\b(?:AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED_SECRET]")
    .replace(/-----BEGIN (?:RSA|EC|OPENSSH|DSA) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|EC|OPENSSH|DSA) PRIVATE KEY-----/g, "[REDACTED_SECRET]")
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/)[^/@\s]+@/gi, "$1[REDACTED]@");
}
