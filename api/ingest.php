<?php
declare(strict_types=1);

require_once __DIR__ . '/lib.php';

set_time_limit(0);

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_out(['error' => 'POST required'], 405);
}
if (empty($_FILES['files'])) {
    json_out(['error' => 'No files uploaded.'], 400);
}

$files = $_FILES['files'];
$names = is_array($files['name']) ? $files['name'] : [$files['name']];
$tmps  = is_array($files['tmp_name']) ? $files['tmp_name'] : [$files['tmp_name']];
$sizes = is_array($files['size']) ? $files['size'] : [$files['size']];
$errs  = is_array($files['error']) ? $files['error'] : [$files['error']];

$results = [];

for ($i = 0; $i < count($names); $i++) {
    $name = (string) $names[$i];
    $tmp  = (string) $tmps[$i];
    $size = (int) $sizes[$i];
    $err  = (int) $errs[$i];
    $ext  = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $dest = null;

    try {
        if ($err !== UPLOAD_ERR_OK) {
            throw new RuntimeException('Upload failed (code ' . $err . '). Is the file larger than the server limit?');
        }
        if ($size <= 0) {
            throw new RuntimeException('The file is empty.');
        }
        if ($size > MAX_UPLOAD_BYTES) {
            throw new RuntimeException('File too large (limit ' . round(MAX_UPLOAD_BYTES / 1048576) . ' MB).');
        }
        if (!in_array($ext, ALLOWED_EXTS, true)) {
            throw new RuntimeException('Unsupported file type: .' . $ext);
        }
        if (!is_uploaded_file($tmp)) {
            throw new RuntimeException('Invalid upload.');
        }

        ensure_dirs();
        $stored = date('Ymd_His') . '_' . bin2hex(random_bytes(4)) . '.' . $ext;
        $dest   = UPLOAD_DIR . DIRECTORY_SEPARATOR . $stored;
        if (!move_uploaded_file($tmp, $dest)) {
            throw new RuntimeException('Could not store the uploaded file.');
        }

        $text = extract_document($dest, $ext);
        $chunks = chunk_text($text);
        if (!$chunks) {
            throw new RuntimeException('No readable text was found in this file.');
        }

        $vectors = ollama_embed($chunks);

        $pdo = db();
        $pdo->beginTransaction();
        $stmt = $pdo->prepare('INSERT INTO documents (name, filename, ext, size, created_at, chunk_count) VALUES (?,?,?,?,?,?)');
        $stmt->execute([$name, $stored, $ext, $size, gmdate('c'), count($chunks)]);
        $docId = (int) $pdo->lastInsertId();

        $ins = $pdo->prepare('INSERT INTO chunks (doc_id, ord, text, embedding, dim) VALUES (?,?,?,?,?)');
        foreach ($chunks as $ord => $chunk) {
            $vec = $vectors[$ord] ?? [];
            $ins->execute([$docId, $ord, $chunk, json_encode($vec), count($vec)]);
        }
        $pdo->commit();

        $results[] = ['name' => $name, 'ok' => true, 'chunks' => count($chunks), 'doc_id' => $docId];
    } catch (Throwable $e) {
        if (is_string($dest) && is_file($dest)) {
            @unlink($dest);
        }
        $results[] = ['name' => $name, 'ok' => false, 'error' => $e->getMessage()];
    }
}

json_out(['results' => $results]);
