<?php
declare(strict_types=1);

require_once __DIR__ . '/lib.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $docs  = db()->query('SELECT id, name, ext, size, created_at, chunk_count FROM documents ORDER BY id DESC')->fetchAll();
    $total = (int) db()->query('SELECT COUNT(*) FROM chunks')->fetchColumn();
    json_out(['documents' => $docs, 'total_chunks' => $total]);
}

if ($method === 'POST') {
    $body   = read_json_body();
    $action = $body['action'] ?? '';

    if ($action === 'delete') {
        $id = (int) ($body['id'] ?? 0);
        if ($id <= 0) {
            json_out(['error' => 'Invalid document id.'], 400);
        }
        $stmt = db()->prepare('SELECT filename FROM documents WHERE id = ?');
        $stmt->execute([$id]);
        $filename = $stmt->fetchColumn();

        db()->prepare('DELETE FROM chunks WHERE doc_id = ?')->execute([$id]);
        db()->prepare('DELETE FROM documents WHERE id = ?')->execute([$id]);

        if ($filename) {
            $path = UPLOAD_DIR . DIRECTORY_SEPARATOR . basename((string) $filename);
            if (is_file($path)) {
                @unlink($path);
            }
        }
        json_out(['ok' => true]);
    }

    if ($action === 'clear') {
        db()->exec('DELETE FROM chunks');
        db()->exec('DELETE FROM documents');
        foreach ((glob(UPLOAD_DIR . DIRECTORY_SEPARATOR . '*') ?: []) as $file) {
            if (is_file($file)) {
                @unlink($file);
            }
        }
        json_out(['ok' => true]);
    }

    json_out(['error' => 'Unknown action.'], 400);
}

json_out(['error' => 'Method not allowed.'], 405);
