#!/bin/bash
# verify-corrections.sh — Vérification automatique des corrections v4
# Exécution :  bash scripts/verify-corrections.sh

set -e
PASS=0
FAIL=0

check() {
    local name="$1"
    shift
    if eval "$@"; then
        echo "  ✓ $name"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $name"
        FAIL=$((FAIL + 1))
    fi
}

echo "═══════════════════════════════════════════════════════════"
echo "  Vérification des corrections de sécurité v4 — ASUFOR"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── 1. .gitignore ──────────────────────────────────────────
echo "── 1. .gitignore ──"
check "Fichier .gitignore existe" "[ -f .gitignore ]"
check "Exclut serviceAccountKey.json" "grep -q 'serviceAccountKey' .gitignore"
check "Exclut .env" "grep -q '.env' .gitignore"
check "Exclut node_modules" "grep -q 'node_modules' .gitignore"
echo ""

# ── 2. Hachage SHA-256 passcodes agents ────────────────────
echo "── 2. Hachage passcodes agents (SHA-256) ──"
check "Module crypto.js existe" "[ -f crypto.js ]"
check "agent.html charge crypto.js" "grep -q 'crypto.js' agents/agent.html"
check "crypto.js contient hashAgentPasscode" "grep -q 'hashAgentPasscode' crypto.js"
check "crypto.js contient verifyAgentPasscode" "grep -q 'verifyAgentPasscode' crypto.js"
check "crypto.js contient generateMaintenancePasscode" "grep -q 'generateMaintenancePasscode' crypto.js"
echo ""

# ── 3. Numérotation atomique ──────────────────────────────
echo "── 3. Numérotation atomique ──"
check "counter/list.html utilise runTransaction" "grep -q 'runTransaction' counter/list.html"
check "counter/list.html importe runTransaction" "grep -q 'runTransaction' counter/list.html"
check "Script init-counter-number.js existe" "[ -f scripts/init-counter-number.js ]"
echo ""

# ── 4. Passcode maintenance sécurisé ─────────────────────
echo "── 4. Passcode maintenance sécurisé ──"
check "zero.html charge crypto.js" "grep -q 'crypto.js' reset/zero.html"
check "zero.html utilise maintenance_passcode_hash" "grep -q 'maintenance_passcode_hash' reset/zero.html"
check "zero.html contient generateMaintenancePasscode" "grep -q 'generateMaintenancePasscode' reset/zero.html"
echo ""

# ── 5. Anti-brute-force amélioré ─────────────────────────
echo "── 5. Anti-brute-force amélioré ──"
check "index.html utilise localStorage" "grep -q 'localStorage' index.html"
check "index.html a LOCK_DURATIONS_MS (progressif)" "grep -q 'LOCK_DURATIONS_MS' index.html"
check "index.html a verrouillage progressif" "grep -q 'lockLevel' index.html"
echo ""

# ── 6. Persistance des arriérés ──────────────────────────
echo "── 6. Persistance des arriérés ──"
check "impression.html importe set/update/push" "grep -q 'set, update, push' impression/impression.html"
check "impression.html écrit dans Firebase" "grep -q 'await update' impression/impression.html"
check "impression.html crée entrée audit" "grep -q 'audit_arrieres' impression/impression.html"
echo ""

# ── 7. Tests ─────────────────────────────────────────────
echo "── 7. Tests ──"
check "scripts/crypto.test.js existe" "[ -f scripts/crypto.test.js ]"
check "scripts/integration.test.js existe" "[ -f scripts/integration.test.js ]"
check "Tests crypto passent" "node scripts/crypto.test.js > /dev/null 2>&1"
check "Tests intégration passent" "node scripts/integration.test.js > /dev/null 2>&1"
check "Tests billing passent" "node scripts/billing.test.js > /dev/null 2>&1"
echo ""

# ── 8. CI amélioré ───────────────────────────────────────
echo "── 8. Workflow CI ──"
check "ci.yml contient check-secrets" "grep -q 'check-secrets' .github/workflows/ci.yml"
check "ci.yml contient validate-html" "grep -q 'validate-html' .github/workflows/ci.yml"
check "ci.yml contient check-structure" "grep -q 'check-structure' .github/workflows/ci.yml"
echo ""

# ── 9. Règles Firebase ──────────────────────────────────
echo "── 9. Règles Firebase ──"
check "database.rules.json contient passcode_hash" "grep -q 'passcode_hash' database.rules.json"
check "database.rules.json contient next_counter_number" "grep -q 'next_counter_number' database.rules.json"
check "database.rules.json contient maintenance_passcode_hash" "grep -q 'maintenance_passcode_hash' database.rules.json"
check "database.rules.json contient audit_arrieres" "grep -q 'audit_arrieres' database.rules.json"
echo ""

# ── 10. Documentation ──────────────────────────────────
echo "── 10. Documentation ──"
check "docs/CORRECTIONS-v4.md existe" "[ -f docs/CORRECTIONS-v4.md ]"
check "README-FACTURATION.md existe" "[ -f scripts/README-FACTURATION.md ]"
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "  Résultats : $PASS vérifications réussies, $FAIL échouées"
echo "═══════════════════════════════════════════════════════════"

if [ $FAIL -gt 0 ]; then
    exit 1
fi
