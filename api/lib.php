<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

/* ------------------------------------------------------------------ *
 *  Filesystem / database
 * ------------------------------------------------------------------ */

function ensure_dirs(): void
{
    if (!is_dir(DATA_DIR)) {
        @mkdir(DATA_DIR, 0777, true);
    }
    if (!is_dir(UPLOAD_DIR)) {
        @mkdir(UPLOAD_DIR, 0777, true);
    }
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    ensure_dirs();
    $pdo = new PDO('sqlite:' . DB_PATH);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA journal_mode = WAL');
    migrate($pdo);
    return $pdo;
}

function migrate(PDO $pdo): void
{
    $pdo->exec('CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        filename TEXT NOT NULL,
        ext TEXT,
        size INTEGER DEFAULT 0,
        created_at TEXT,
        chunk_count INTEGER DEFAULT 0
    )');

    $pdo->exec('CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL,
        ord INTEGER DEFAULT 0,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dim INTEGER DEFAULT 0,
        FOREIGN KEY(doc_id) REFERENCES documents(id) ON DELETE CASCADE
    )');

    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id)');

    // Long-term memory: short facts about the user, injected into every chat.
    $pdo->exec('CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at TEXT
    )');
}

/* ------------------------------------------------------------------ *
 *  HTTP helpers
 * ------------------------------------------------------------------ */

function json_out($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/* ------------------------------------------------------------------ *
 *  Ollama client
 * ------------------------------------------------------------------ */

function ollama_request(string $path, array $payload, int $timeout = 900): array
{
    $ch = curl_init(OLLAMA_URL . $path);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    $res  = curl_exec($ch);
    $err  = curl_error($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($res === false) {
        throw new RuntimeException('Cannot reach Ollama at ' . OLLAMA_URL . ': ' . $err);
    }
    $data = json_decode((string) $res, true);
    if ($code >= 400) {
        $msg = is_array($data) && isset($data['error']) ? $data['error'] : (string) $res;
        throw new RuntimeException('Ollama error (' . $code . '): ' . $msg);
    }
    return is_array($data) ? $data : [];
}

function ollama_get(string $path, int $timeout = 30): array
{
    $ch = curl_init(OLLAMA_URL . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => 5,
    ]);
    $res  = curl_exec($ch);
    $err  = curl_error($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($res === false) {
        throw new RuntimeException('Cannot reach Ollama at ' . OLLAMA_URL . ': ' . $err);
    }
    $data = json_decode((string) $res, true);
    if ($code >= 400) {
        throw new RuntimeException('Ollama error (' . $code . ')');
    }
    return is_array($data) ? $data : [];
}

/**
 * Embed a list of strings. Returns a list of float vectors (one per input).
 */
function ollama_embed(array $inputs, int $batch = 24): array
{
    $inputs = array_values(array_map('strval', $inputs));
    $vectors = [];
    foreach (array_chunk($inputs, $batch) as $part) {
        $data = ollama_request('/api/embed', [
            'model' => EMBED_MODEL,
            'input' => array_values($part),
        ], 1800);
        if (!isset($data['embeddings']) || !is_array($data['embeddings'])) {
            throw new RuntimeException('The embedding model returned no vectors.');
        }
        foreach ($data['embeddings'] as $vec) {
            $vectors[] = $vec;
        }
    }
    return $vectors;
}

/* ------------------------------------------------------------------ *
 *  Vector math & chunking
 * ------------------------------------------------------------------ */

function cosine(array $a, array $b): float
{
    $n = min(count($a), count($b));
    $dot = 0.0;
    $na = 0.0;
    $nb = 0.0;
    for ($i = 0; $i < $n; $i++) {
        $x = (float) $a[$i];
        $y = (float) $b[$i];
        $dot += $x * $y;
        $na  += $x * $x;
        $nb  += $y * $y;
    }
    if ($na <= 0.0 || $nb <= 0.0) {
        return 0.0;
    }
    return $dot / (sqrt($na) * sqrt($nb));
}

function chunk_text(string $text): array
{
    $text = str_replace(["\r\n", "\r"], "\n", $text);
    $text = (string) preg_replace('/[ \t]+\n/', "\n", $text);
    $text = (string) preg_replace('/\n{3,}/', "\n\n", $text);
    $text = trim($text);
    if ($text === '') {
        return [];
    }
    $len = mb_strlen($text, 'UTF-8');
    if ($len <= CHUNK_SIZE) {
        return [$text];
    }

    $chunks = [];
    $start  = 0;
    $guard  = 0;
    while ($start < $len && $guard++ < 100000) {
        $end = min($start + CHUNK_SIZE, $len);
        if ($end < $len) {
            $windowStart = max($start, $end - 200);
            $window = mb_substr($text, $windowStart, $end - $windowStart, 'UTF-8');
            $best = -1;
            foreach (["\n\n", "\n", '. ', '! ', '? ', '; ', ', '] as $sep) {
                $pos = mb_strrpos($window, $sep, 0, 'UTF-8');
                if ($pos !== false) {
                    $best = $pos + mb_strlen($sep, 'UTF-8');
                    break;
                }
            }
            if ($best > 0) {
                $end = $windowStart + $best;
            }
        }
        $chunk = trim(mb_substr($text, $start, $end - $start, 'UTF-8'));
        if ($chunk !== '') {
            $chunks[] = $chunk;
        }
        $next = $end - CHUNK_OVERLAP;
        if ($next <= $start) {
            $next = $end;
        }
        $start = $next;
    }
    return $chunks;
}

/* ------------------------------------------------------------------ *
 *  Text extraction
 * ------------------------------------------------------------------ */

function python_bin(): ?string
{
    static $resolved = false;
    static $bin = null;
    if ($resolved) {
        return $bin;
    }
    $resolved = true;
    foreach (['python', 'py', 'python3'] as $candidate) {
        $out = @shell_exec($candidate . ' --version 2>&1');
        if (is_string($out) && stripos($out, 'Python') !== false) {
            $bin = $candidate;
            return $bin;
        }
    }
    return null;
}

function extract_with_python(string $path): string
{
    $py = python_bin();
    if ($py === null) {
        throw new RuntimeException('Python is not available, so PDF/DOCX files cannot be read. Install Python or use .txt/.md files.');
    }
    $script = __DIR__ . '/extract.py';
    $cmd = $py . ' ' . escapeshellarg($script) . ' ' . escapeshellarg($path) . ' 2>&1';
    $lines = [];
    $code = 0;
    exec($cmd, $lines, $code);
    $out = implode("\n", $lines);
    if ($code !== 0) {
        throw new RuntimeException('Could not extract text: ' . trim($out));
    }
    return $out;
}

function extract_text_like(string $path, string $ext): string
{
    $raw = file_get_contents($path);
    if ($raw === false) {
        throw new RuntimeException('The file could not be read.');
    }
    if (in_array($ext, ['html', 'htm', 'xhtml'], true)) {
        $raw = (string) preg_replace('/<script\b[^>]*>.*?<\/script>/is', ' ', $raw);
        $raw = (string) preg_replace('/<style\b[^>]*>.*?<\/style>/is', ' ', $raw);
        $raw = strip_tags($raw);
        $raw = html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }
    return (string) $raw;
}

function extract_document(string $path, string $ext): string
{
    $ext = strtolower($ext);
    if ($ext === 'pdf' || $ext === 'docx') {
        return extract_with_python($path);
    }
    if ($ext === 'doc') {
        throw new RuntimeException('The old .doc format is not supported. Save it as .docx or .txt first.');
    }
    return extract_text_like($path, $ext);
}

/* ------------------------------------------------------------------ *
 *  Retrieval
 * ------------------------------------------------------------------ */

function doc_chunk_count(): int
{
    return (int) db()->query('SELECT COUNT(*) FROM chunks')->fetchColumn();
}

/**
 * Return the top-K chunks most similar to the query vector.
 * @return array<int,array{score:float,text:string,doc_id:int,name:string}>
 */
function search_chunks(array $queryVec, int $topK, ?array $docIds = null): array
{
    $pdo = db();
    $sql = 'SELECT c.id, c.text, c.embedding, c.doc_id, d.name
            FROM chunks c JOIN documents d ON d.id = c.doc_id';
    $params = [];
    if (is_array($docIds) && $docIds) {
        $ids = array_values(array_filter(array_map('intval', $docIds), fn($v) => $v > 0));
        if ($ids) {
            $sql .= ' WHERE c.doc_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')';
            $params = $ids;
        }
    }
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $scored = [];
    while ($row = $stmt->fetch()) {
        $vec = json_decode((string) $row['embedding'], true);
        if (!is_array($vec) || !$vec) {
            continue;
        }
        $scored[] = [
            'score'  => cosine($queryVec, $vec),
            'text'   => (string) $row['text'],
            'doc_id' => (int) $row['doc_id'],
            'name'   => (string) $row['name'],
        ];
    }
    usort($scored, static fn($a, $b) => $b['score'] <=> $a['score']);
    return array_slice($scored, 0, max(1, $topK));
}
