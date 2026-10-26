<?php
declare(strict_types=1);

require_once __DIR__ . '/lib.php';

try {
    $data   = ollama_get('/api/tags');
    $models = [];
    foreach (($data['models'] ?? []) as $m) {
        $name = $m['name'] ?? ($m['model'] ?? 'unknown');
        $models[] = [
            'name'   => $name,
            'size'   => $m['size'] ?? 0,
            'family' => $m['details']['family'] ?? '',
            'params' => $m['details']['parameter_size'] ?? '',
            'kind'   => (str_contains($name, 'embed')) ? 'embedding' : 'chat',
        ];
    }
    json_out(['models' => $models]);
} catch (Throwable $e) {
    json_out(['models' => [], 'error' => $e->getMessage()]);
}
