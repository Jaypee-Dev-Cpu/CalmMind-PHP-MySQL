<?php
// ============================================================================
// CalmMind User Study Data Sync API (Load & Save per Authorized User)
// ============================================================================

declare(strict_types=1);
require_once __DIR__ . '/db.php';

if (empty($_SESSION['user_id'])) {
    sendJson(401, ['success' => false, 'message' => 'Unauthorized. Please sign in.']);
}

$userId = (int)$_SESSION['user_id'];
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $pdo->prepare('SELECT state_json, updated_at FROM user_study_data WHERE user_id = :user_id LIMIT 1');
    $stmt->execute([':user_id' => $userId]);
    $row = $stmt->fetch();

    if (!$row) {
        sendJson(200, ['success' => true, 'state' => null]);
    }

    $decodedState = json_decode($row['state_json'], true);
    sendJson(200, [
        'success'    => true,
        'state'      => is_array($decodedState) ? $decodedState : null,
        'updated_at' => $row['updated_at'],
    ]);
}

if ($method === 'POST') {
    $input = getJsonInput();
    if (!isset($input['state']) || !is_array($input['state'])) {
        sendJson(400, ['success' => false, 'message' => 'Invalid study state payload.']);
    }

    $encodedState = json_encode($input['state'], JSON_UNESCAPED_UNICODE);

    $stmt = $pdo->prepare(
        'INSERT INTO user_study_data (user_id, state_json)
         VALUES (:user_id, :state_json)
         ON DUPLICATE KEY UPDATE state_json = VALUES(state_json), updated_at = CURRENT_TIMESTAMP'
    );
    $stmt->execute([
        ':user_id'    => $userId,
        ':state_json' => $encodedState,
    ]);

    sendJson(200, [
        'success' => true,
        'message' => 'Study data saved to MySQL.',
    ]);
}

sendJson(405, ['success' => false, 'message' => 'Method not allowed.']);
