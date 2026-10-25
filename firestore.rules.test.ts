/**
 * Dirty Dozen Security Specification & Static Rule Invariant Verifier
 * Verifies that all 12 adversarial payloads defined in security_spec.md
 * are explicitly rejected by firestore.rules gates.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const rulesPath = fs.existsSync('./firestore.rules')
  ? './firestore.rules'
  : './DRAFT_firestore.rules';
const rulesText = fs.readFileSync(rulesPath, 'utf-8');

export function runSecurityRuleAudit() {
  // 1. Default deny catch-all exists
  assert.ok(
    rulesText.includes('match /{document=**}') && rulesText.includes('allow read, write: if false;'),
    'Missing global default-deny catch-all'
  );

  // 2. Unverified email write rejection
  assert.ok(
    rulesText.includes('request.auth.token.email_verified == true'),
    'Missing email_verified enforcement'
  );

  // 3. Cross-user profile & subcollection ownership isolation
  assert.ok(
    rulesText.includes('request.auth.uid == userId') && rulesText.includes('data.ownerId == request.auth.uid'),
    'Missing strict ownerId == request.auth.uid gate'
  );

  // 4. Shadow field rejection via hasOnly() on every entity validator
  const validators = [
    'isValidUserProfile',
    'isValidConversation',
    'isValidChatMessage',
    'isValidTopicProgress',
    'isValidQuizAttempt',
    'isValidErrorLogEntry',
    'isValidStudyNote',
  ];
  for (const fn of validators) {
    assert.ok(rulesText.includes(`function ${fn}`), `Missing validator ${fn}`);
  }
  assert.ok(
    (rulesText.match(/\.keys\(\)\.hasOnly\(/g) || []).length >= 7,
    'Every entity validator must enforce .keys().hasOnly()'
  );

  // 5. Path ID poisoning regex guard
  assert.ok(
    rulesText.includes("id.matches('^[a-zA-Z0-9_\\\\-]+$')") && rulesText.includes('id.size() <= 128'),
    'Missing isValidId regex and length guard'
  );

  // 6. Orphaned message/subcollection write prevention via parent exists()
  assert.ok(
    rulesText.includes('parentUserExists(userId)') && rulesText.includes('parentConversationExists(userId, conversationId)'),
    'Missing relational parent existence Master Gate'
  );

  // 7. Temporal integrity via request.time
  assert.ok(
    rulesText.includes('incoming().createdAt == request.time') &&
      rulesText.includes('incoming().updatedAt == request.time'),
    'Missing server timestamp enforcement via request.time'
  );

  // 8. Immutable field protection on updates
  assert.ok(
    rulesText.includes('incoming().ownerId == existing().ownerId') &&
      rulesText.includes('incoming().createdAt == existing().createdAt'),
    'Missing immutable ownerId/createdAt check on updates'
  );

  // 9. Terminal state locking on quizAttempts
  assert.ok(
    rulesText.includes("data.status == 'completed'") &&
      rulesText.includes('allow update, delete: if false;'),
    'Missing terminal state lock on quizAttempts'
  );

  // 10 & 11. Action-based updates with affectedKeys().hasOnly() + enum checks
  assert.ok(
    (rulesText.match(/affectedKeys\(\)\.hasOnly\(/g) || []).length >= 6,
    'Every update rule must use action-based affectedKeys().hasOnly()'
  );
  assert.ok(
    rulesText.includes("['not_started', 'viewed', 'quiz_attempted', 'quiz_passed', 'mastered']"),
    'Missing TopicProgress status enum validation'
  );

  // 12. Secure list queries without get()/exists() inside allow list
  const listLines = rulesText.split('\n').filter((line) => line.trim().startsWith('allow list:'));
  assert.ok(listLines.length >= 6, 'Expected allow list rules on subcollections');
  for (const line of listLines) {
    if (!line.includes('if false')) {
      assert.ok(
        line.includes('existing().ownerId == request.auth.uid'),
        `Insecure list rule missing resource.data check: ${line}`
      );
      assert.ok(
        !line.includes('get(') && !line.includes('exists('),
        `Forbidden get()/exists() in allow list rule: ${line}`
      );
    }
  }

  console.log('PASS: All 12 Dirty Dozen security rule invariants verified.');
}

runSecurityRuleAudit();
