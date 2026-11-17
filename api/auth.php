<?php
// ============================================================================
// CalmMind Authentication & Session API (Register, Login, Check Session, Logout)
// ============================================================================

declare(strict_types=1);
require_once __DIR__ . '/db.php';

$action = $_GET['action'] ?? '';
$input  = getJsonInput();

if ($action === 'register') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        sendJson(405, ['success' => false, 'message' => 'Method not allowed.']);
    }

    $fullName = trim((string)($input['full_name'] ?? ''));
    $username = strtolower(trim((string)($input['username'] ?? '')));
    $password = (string)($input['password'] ?? '');

    if ($fullName === '' || $username === '' || $password === '') {
        sendJson(400, ['success' => false, 'message' => 'All fields are required.']);
    }

    if (!preg_match('/^[a-z0-9._-]{3,50}$/', $username)) {
        sendJson(400, [
            'success' => false,
            'message' => 'Username must be 3-50 characters (letters, numbers, dots, underscores, hyphens).'
        ]);
    }

    if (strlen($password) < 6) {
        sendJson(400, ['success' => false, 'message' => 'Password must be at least 6 characters.']);
    }

    // Check if username already exists
    $stmt = $pdo->prepare('SELECT id FROM users WHERE username = :username LIMIT 1');
    $stmt->execute([':username' => $username]);
    if ($stmt->fetch()) {
        sendJson(409, ['success' => false, 'message' => 'Username is already taken. Choose another.']);
    }

    $passwordHash = password_hash($password, PASSWORD_DEFAULT);

    $pdo->beginTransaction();
    try {
        $insertUser = $pdo->prepare(
            'INSERT INTO users (full_name, username, password_hash) VALUES (:full_name, :username, :password_hash)'
        );
        $insertUser->execute([
            ':full_name'     => $fullName,
            ':username'      => $username,
            ':password_hash' => $passwordHash,
        ]);

        $userId = (int)$pdo->lastInsertId();

        $defaultState = json_encode([
            'exams'          => [],
            'tasks'          => [],
            'focusLogs'      => new stdClass(),
            'points'         => 0,
            'streak'         => 0,
            'lastActiveDate' => null,
            'moodHistory'    => [],
            'timerMinutes'   => 25,
        ]);

        $insertData = $pdo->prepare(
            'INSERT INTO user_study_data (user_id, state_json) VALUES (:user_id, :state_json)'
        );
        $insertData->execute([
            ':user_id'    => $userId,
            ':state_json' => $defaultState,
        ]);

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        sendJson(500, ['success' => false, 'message' => 'Failed to create account.']);
    }

    session_regenerate_id(true);
    $_SESSION['user_id']   = $userId;
    $_SESSION['username']  = $username;
    $_SESSION['full_name'] = $fullName;

    sendJson(201, [
        'success' => true,
        'message' => 'Account created successfully.',
        'user'    => [
            'id'        => $userId,
            'username'  => $username,
            'full_name' => $fullName,
        ],
    ]);
}

if ($action === 'login') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        sendJson(405, ['success' => false, 'message' => 'Method not allowed.']);
    }

    $username = strtolower(trim((string)($input['username'] ?? '')));
    $password = (string)($input['password'] ?? '');

    if ($username === '' || $password === '') {
        sendJson(400, ['success' => false, 'message' => 'Enter both username and password.']);
    }

    $stmt = $pdo->prepare(
        'SELECT id, full_name, username, password_hash FROM users WHERE username = :username LIMIT 1'
    );
    $stmt->execute([':username' => $username]);
    $user = $stmt->fetch();

    if (!$user || !password_verify($password, $user['password_hash'])) {
        sendJson(401, ['success' => false, 'message' => 'Invalid username or password.']);
    }

    session_regenerate_id(true);
    $_SESSION['user_id']   = (int)$user['id'];
    $_SESSION['username']  = $user['username'];
    $_SESSION['full_name'] = $user['full_name'];

    sendJson(200, [
        'success' => true,
        'message' => 'Signed in successfully.',
        'user'    => [
            'id'        => (int)$user['id'],
            'username'  => $user['username'],
            'full_name' => $user['full_name'],
        ],
    ]);
}

if ($action === 'me') {
    if (empty($_SESSION['user_id'])) {
        sendJson(200, ['success' => false, 'authenticated' => false]);
    }

    sendJson(200, [
        'success'       => true,
        'authenticated' => true,
        'user'          => [
            'id'        => (int)$_SESSION['user_id'],
            'username'  => (string)$_SESSION['username'],
            'full_name' => (string)$_SESSION['full_name'],
        ],
    ]);
}

if ($action === 'logout') {
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(
            session_name(),
            '',
            time() - 42000,
            $params['path'],
            $params['domain'],
            $params['secure'],
            $params['httponly']
        );
    }
    session_destroy();

    sendJson(200, ['success' => true, 'message' => 'Logged out.']);
}

sendJson(400, ['success' => false, 'message' => 'Invalid auth action.']);
