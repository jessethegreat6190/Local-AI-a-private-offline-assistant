<?php
declare(strict_types=1);

require_once __DIR__ . '/lib.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $items = db()->query('SELECT id, text, created_at FROM memory ORDER BY id')->fetchAll();
    json_out(['items' => $items]);
}

if ($method === 'POST') {
    $body   = read_json_body();
    $action = $body['action'] ?? '';

    if ($action === 'add') {
        $raw = trim((string) ($body['text'] ?? ''));
        if ($raw === '') {
            json_out(['error' => 'Memory text is empty.'], 400);
        }
        // One fact per line, so pasting a list works.
        $lines = preg_split('/\r\n|\r|\n/', $raw) ?: [];
        $lines = array_values(array_filter(array_map(static fn($l) => trim((string) $l), $lines), static fn($l) => $l !== ''));
        if (!$lines) {
            json_out(['error' => 'Memory text is empty.'], 400);
        }
        $stmt = db()->prepare('INSERT INTO memory (text, created_at) VALUES (?, ?)');
        $now  = gmdate('c');
        foreach ($lines as $line) {
            $stmt->execute([$line, $now]);
        }
        json_out(['ok' => true, 'added' => count($lines)]);
    }

    if ($action === 'update') {
        $id   = (int) ($body['id'] ?? 0);
        $text = trim((string) ($body['text'] ?? ''));
        if ($id <= 0 || $text === '') {
            json_out(['error' => 'Invalid memory update.'], 400);
        }
        db()->prepare('UPDATE memory SET text = ? WHERE id = ?')->execute([$text, $id]);
        json_out(['ok' => true]);
    }

    if ($action === 'delete') {
        $id = (int) ($body['id'] ?? 0);
        if ($id <= 0) {
            json_out(['error' => 'Invalid id.'], 400);
        }
        db()->prepare('DELETE FROM memory WHERE id = ?')->execute([$id]);
        json_out(['ok' => true]);
    }

    if ($action === 'clear') {
        db()->exec('DELETE FROM memory');
        json_out(['ok' => true]);
    }

    json_out(['error' => 'Unknown action.'], 400);
}

json_out(['error' => 'Method not allowed.'], 405);
