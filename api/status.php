<?php
declare(strict_types=1);

require_once __DIR__ . '/lib.php';

$out = [
    'ollama'      => false,
    'version'     => '',
    'docs'        => 0,
    'chunks'      => 0,
    'embed_model' => EMBED_MODEL,
];

try {
    $v = ollama_get('/api/version');
    $out['ollama']  = true;
    $out['version'] = $v['version'] ?? '';
} catch (Throwable $e) {
    $out['ollama_error'] = $e->getMessage();
}

try {
    $out['docs']   = (int) db()->query('SELECT COUNT(*) FROM documents')->fetchColumn();
    $out['chunks'] = (int) db()->query('SELECT COUNT(*) FROM chunks')->fetchColumn();
} catch (Throwable $e) {
    $out['db_error'] = $e->getMessage();
}

json_out($out);
