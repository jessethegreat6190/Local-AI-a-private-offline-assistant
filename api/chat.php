<?php
declare(strict_types=1);

require_once __DIR__ . '/lib.php';

set_time_limit(0);
ignore_user_abort(true);

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_out(['error' => 'POST required'], 405);
}

$body = read_json_body();
$messages = $body['messages'] ?? [];
if (!is_array($messages) || !$messages) {
    json_out(['error' => 'No messages provided.'], 400);
}

$model       = trim((string) ($body['model'] ?? '')) ?: 'llama3.2:3b';
$useRag      = !empty($body['use_rag']);
$topK        = (int) ($body['top_k'] ?? DEFAULT_TOP_K);
$temperature = isset($body['temperature']) ? (float) $body['temperature'] : 0.7;
$docIds      = (isset($body['doc_ids']) && is_array($body['doc_ids'])) ? $body['doc_ids'] : null;
$overrideSystem = trim((string) ($body['system'] ?? ''));
$useMemory   = !isset($body['use_memory']) || !empty($body['use_memory']);

// Sanitise the conversation (text + optional images for vision models).
$clean = [];
foreach ($messages as $m) {
    if (!is_array($m)) {
        continue;
    }
    $role    = (($m['role'] ?? '') === 'assistant') ? 'assistant' : 'user';
    $content = (string) ($m['content'] ?? '');

    $imgs = [];
    if (isset($m['images']) && is_array($m['images'])) {
        foreach ($m['images'] as $img) {
            if (!is_string($img) || $img === '') {
                continue;
            }
            // Accept both raw base64 and data URLs; Ollama wants raw base64.
            if (str_contains($img, ',')) {
                $comma = strpos($img, ',');
                if ($comma !== false && str_contains(substr($img, 0, $comma), 'base64')) {
                    $img = substr($img, $comma + 1);
                }
            }
            $imgs[] = $img;
        }
    }

    if ($content === '' && !$imgs) {
        continue;
    }
    $entry = ['role' => $role, 'content' => $content];
    if ($imgs) {
        $entry['images'] = $imgs;
    }
    $clean[] = $entry;
}
if (!$clean) {
    json_out(['error' => 'No valid messages.'], 400);
}

// ------------------------------------------------------------------
//  Build retrieval context (RAG) before streaming starts.
// ------------------------------------------------------------------
$sources      = [];
$systemPrefix = null;

if ($useRag) {
    try {
        $lastUser = '';
        for ($i = count($clean) - 1; $i >= 0; $i--) {
            if ($clean[$i]['role'] === 'user') {
                $lastUser = $clean[$i]['content'];
                break;
            }
        }
        if ($lastUser !== '' && doc_chunk_count() > 0) {
            $vectors = ollama_embed([$lastUser]);
            $hits    = search_chunks($vectors[0], max(1, min(20, $topK)), $docIds);
            if ($hits) {
                $context = '';
                foreach ($hits as $i => $hit) {
                    $n = $i + 1;
                    $context .= "\n--- Source {$n} ({$hit['name']}) ---\n{$hit['text']}\n";
                    $sources[] = [
                        'name'    => $hit['name'],
                        'score'   => round($hit['score'], 3),
                        'preview' => mb_substr(trim($hit['text']), 0, 240),
                    ];
                }
                $systemPrefix =
                    "You are a private, helpful assistant running entirely on the user's own computer.\n" .
                    "Use the CONTEXT below to answer the user's question whenever it is relevant. " .
                    "Cite the sources you rely on as [Source N].\n" .
                    "If the answer is not in the context, say so briefly, then you may still help from general " .
                    "knowledge — but make clear that part is not from the user's documents.\n\n" .
                    "CONTEXT:\n" . $context;
            }
        }
    } catch (Throwable $e) {
        // Retrieval failed — fall back to a normal chat so the user still gets a reply.
    }
}

$systemParts = [];

// Long-term memory about the user (stored only in the local SQLite DB).
if ($useMemory) {
    try {
        $memRows = db()->query('SELECT text FROM memory ORDER BY id')->fetchAll();
        $facts = [];
        foreach ($memRows as $row) {
            $t = trim((string) ($row['text'] ?? ''));
            if ($t !== '') {
                $facts[] = '- ' . $t;
            }
        }
        if ($facts) {
            $systemParts[] =
                "ABOUT THE USER (long-term memory saved on their own computer; use it naturally, " .
                "do not recite it unless relevant, and never invent facts about them):\n" .
                implode("\n", $facts);
        }
    } catch (Throwable $e) {
        // Memory table unavailable — continue without it.
    }
}

if ($overrideSystem !== '') {
    $systemParts[] = $overrideSystem;
}
if ($systemPrefix !== null) {
    $systemParts[] = $systemPrefix;
}

$payloadMessages = $clean;
if ($systemParts) {
    array_unshift($payloadMessages, ['role' => 'system', 'content' => implode("\n\n", $systemParts)]);
}

// ------------------------------------------------------------------
//  Stream NDJSON back to the browser.
// ------------------------------------------------------------------
while (ob_get_level() > 0) {
    @ob_end_clean();
}
header('Content-Type: application/x-ndjson; charset=utf-8');
header('Cache-Control: no-cache, no-store, must-revalidate');
header('X-Accel-Buffering: no');
@ini_set('zlib.output_compression', '0');
ob_implicit_flush(true);

$emit = static function (array $data): void {
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
    @flush();
};

if ($sources) {
    $emit(['type' => 'sources', 'sources' => $sources]);
}

$payload = [
    'model'    => $model,
    'messages' => $payloadMessages,
    'stream'   => true,
    'options'  => ['temperature' => $temperature],
];

$buffer = '';
$ch = curl_init(OLLAMA_URL . '/api/chat');
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
    CURLOPT_TIMEOUT        => 0,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_WRITEFUNCTION  => function ($ch, $chunk) use (&$buffer, $emit) {
        $buffer .= $chunk;
        while (($pos = strpos($buffer, "\n")) !== false) {
            $line   = trim(substr($buffer, 0, $pos));
            $buffer = substr($buffer, $pos + 1);
            if ($line === '') {
                continue;
            }
            $obj = json_decode($line, true);
            if (!is_array($obj)) {
                continue;
            }
            if (isset($obj['error'])) {
                $emit(['type' => 'error', 'message' => (string) $obj['error']]);
                continue;
            }
            if (isset($obj['message']['content']) && $obj['message']['content'] !== '') {
                $emit(['type' => 'delta', 'content' => $obj['message']['content']]);
            }
            if (!empty($obj['done'])) {
                $emit([
                    'type'           => 'done',
                    'eval_count'     => $obj['eval_count'] ?? null,
                    'eval_duration'  => $obj['eval_duration'] ?? null,
                    'total_duration' => $obj['total_duration'] ?? null,
                ]);
            }
        }
        return strlen($chunk);
    },
]);

if (curl_exec($ch) === false) {
    $emit(['type' => 'error', 'message' => 'Connection to Ollama failed: ' . curl_error($ch)]);
}
curl_close($ch);
$emit(['type' => 'end']);
