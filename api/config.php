<?php
declare(strict_types=1);

/**
 * Local AI — configuration
 * Everything here is 100% local. Nothing is sent to any external service.
 */

date_default_timezone_set('UTC');

define('OLLAMA_URL', getenv('OLLAMA_URL') ?: 'http://127.0.0.1:11434');

define('APP_ROOT', dirname(__DIR__));
define('DATA_DIR', APP_ROOT . DIRECTORY_SEPARATOR . 'data');
define('UPLOAD_DIR', DATA_DIR . DIRECTORY_SEPARATOR . 'uploads');
define('DB_PATH', DATA_DIR . DIRECTORY_SEPARATOR . 'localai.sqlite');

// Embedding model used to index your documents (768-dim, runs locally via Ollama)
define('EMBED_MODEL', 'nomic-embed-text');

// How documents are split before embedding
define('CHUNK_SIZE', 1000);
define('CHUNK_OVERLAP', 150);

// Retrieval defaults
define('DEFAULT_TOP_K', 5);
define('MAX_UPLOAD_BYTES', 50 * 1024 * 1024); // 50 MB

// File types the knowledge base accepts
define('ALLOWED_EXTS', [
    'pdf', 'docx',
    'txt', 'md', 'markdown', 'csv', 'json', 'log', 'ini', 'toml',
    'html', 'htm', 'xhtml', 'xml', 'yml', 'yaml',
    'js', 'ts', 'jsx', 'tsx', 'py', 'php', 'rb', 'go', 'rs',
    'java', 'c', 'h', 'cpp', 'cs', 'css', 'scss', 'sql', 'sh', 'bat', 'ps1',
]);
