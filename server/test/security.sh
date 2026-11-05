#!/usr/bin/env bash
# Security regression checks against a running dev API. Usage: [B=http://localhost:8788] bash test/security.sh
# NOTE: the idempotency block creates ONE real standard (1:1) job; it is generated only if a worker is running.
B=${B:-http://localhost:8787}; O=${O:-http://localhost:5173}
source <(grep -E '^ADMIN_(EMAIL|PASSWORD)=' .env)
# dev only: reset rate-limit counters so repeated runs start clean
redis-cli --scan --pattern "fastify*" | xargs -r redis-cli del >/dev/null; redis-cli --scan --pattern "login_fail*" | xargs -r redis-cli del >/dev/null
pass=0; fail=0
check(){ if [[ "$2" == "$3" ]]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got $2, want $3)"; fail=$((fail+1)); fi; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
H=(-H "Origin: $O" -H "X-Requested-With: lumi" -H "Content-Type: application/json")
# --- users
U1=/tmp/s1.jar; U2=/tmp/s2.jar; A=/tmp/sa.jar; rm -f $U1 $U2 $A
curl -s -c $A "${H[@]}" -X POST $B/api/auth/login -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" >/dev/null
CODES=$(curl -s -b $A "${H[@]}" -X POST $B/api/admin/invites -d '{"count":2,"credits":10,"batch":"sec"}')
C1=$(echo $CODES | python3 -c 'import sys,json;print(json.load(sys.stdin)["codes"][0])'); C2=$(echo $CODES | python3 -c 'import sys,json;print(json.load(sys.stdin)["codes"][1])')
curl -s -c $U1 "${H[@]}" -X POST $B/api/auth/register -d "{\"email\":\"s1$RANDOM@t.local\",\"password\":\"password-1\",\"inviteCode\":\"$C1\"}" >/dev/null
curl -s -c $U2 "${H[@]}" -X POST $B/api/auth/register -d "{\"email\":\"s2$RANDOM@t.local\",\"password\":\"password-2\",\"inviteCode\":\"$C2\"}" >/dev/null
P1=$(curl -s -b $U1 "${H[@]}" -X POST $B/api/projects -d '{"mode":"simple"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

check "CSRF: missing X-Requested-With" $(code -b $U1 -H "Origin: $O" -H "Content-Type: application/json" -X POST $B/api/projects -d '{"mode":"simple"}') 403
check "CSRF: foreign Origin" $(code -b $U1 -H "Origin: https://evil.example" -H "X-Requested-With: lumi" -H "Content-Type: application/json" -X POST $B/api/projects -d '{"mode":"simple"}') 403
check "unauthenticated projects" $(code $B/api/projects) 401
check "IDOR: user2 reads user1 project jobs" $(code -b $U2 $B/api/projects/$P1/jobs) 404
check "IDOR: user2 renames user1 project" $(code -b $U2 "${H[@]}" -X PATCH $B/api/projects/$P1 -d '{"name":"x"}') 404
check "user cannot reach admin" $(code -b $U1 $B/api/admin/users) 403
check "user cannot create invites" $(code -b $U1 "${H[@]}" -X POST $B/api/admin/invites -d '{"count":1,"credits":99999}') 403
check "SQLi-ish email rejected" $(code "${H[@]}" -X POST $B/api/auth/login -d "{\"email\":\"' OR 1=1--\",\"password\":\"x\"}") 400
check "bad uuid param" $(code -b $U1 $B/api/jobs/1%20OR%201=1) 400
check "negative perRatio" $(code -b $U1 "${H[@]}" -X POST $B/api/jobs -d "{\"projectId\":\"$P1\",\"prompt\":\"x\",\"ratios\":[\"1:1\"],\"perRatio\":-5}") 400
check "too many images" $(code -b $U1 "${H[@]}" -X POST $B/api/jobs -d "{\"projectId\":\"$P1\",\"prompt\":\"x\",\"ratios\":[\"1:1\",\"3:4\",\"9:16\"],\"perRatio\":4}") 400
check "insufficient credits (10cr, 8 imgs x2)" $(code -b $U1 "${H[@]}" -X POST $B/api/jobs -d "{\"projectId\":\"$P1\",\"prompt\":\"x\",\"ratios\":[\"1:1\",\"3:4\"],\"perRatio\":4}") 402
echo "<?php system(\$_GET['c']); ?>" > /tmp/evil.jpg
check "non-image upload rejected" $(code -b $U1 -H "Origin: $O" -H "X-Requested-With: lumi" -F "file=@/tmp/evil.jpg" $B/api/uploads) 400
head -c 16000000 /dev/zero > /tmp/big.jpg
check "oversize upload rejected" $(code -b $U1 -H "Origin: $O" -H "X-Requested-With: lumi" -F "file=@/tmp/big.jpg" $B/api/uploads) 400
check "file without signature" $(code "$B/files/uploads/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000.jpg") 403
check "path traversal in files" $(code "$B/files/..%2F..%2F.env?exp=9999999999&dl=0&sig=x") 403
check "SSRF: admin cannot add private upstream" $(code -b $A "${H[@]}" -X POST $B/api/admin/channels -d '{"name":"x","vendor":"openai_compat","baseUrl":"https://127.0.0.1/v1","apiKey":"k"}') 400
check "SSRF: metadata IP" $(code -b $A "${H[@]}" -X POST $B/api/admin/channels -d '{"name":"x","vendor":"openai_compat","baseUrl":"https://169.254.169.254/latest","apiKey":"k"}') 400
check "SSRF: http scheme" $(code -b $A "${H[@]}" -X POST $B/api/admin/channels -d '{"name":"x","vendor":"openai_compat","baseUrl":"http://example.com/v1","apiKey":"k"}') 400
KEYS=$(curl -s -b $A $B/api/admin/channels)
check "channel list never returns api key" $(echo "$KEYS" | grep -c -i -E 'api_key_enc|proxy-injected') 0
check "settings: unknown key rejected" $(code -b $A "${H[@]}" -X PUT $B/api/admin/settings -d '{"evil":1}') 400
# --- idempotent job creation (ONE real 1-image job): 5 parallel duplicates → 1 job, charged once
jget(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
CR0=$(curl -s -b $U1 $B/api/me | jget 'd["user"]["credits"]')
IK=$(python3 -c 'import uuid;print(uuid.uuid4())')
JB="{\"projectId\":\"$P1\",\"prompt\":\"idempotency test: white ceramic mug on white background\",\"ratios\":[\"1:1\"],\"perRatio\":1}"
rm -f /tmp/idem[1-5].out /tmp/idem[1-5].code
for i in 1 2 3 4 5; do curl -s -b $U1 "${H[@]}" -H "Idempotency-Key: $IK" -X POST $B/api/jobs -d "$JB" -o /tmp/idem$i.out -w '%{http_code}\n' > /tmp/idem$i.code & done; wait
check "idempotency: all duplicates 200" $(cat /tmp/idem[1-5].code | sort -u | tr -d '\n') 200
# each .out has no trailing newline, so read every file on its own (cat would glue the JSON objects together)
check "idempotency: one job id" $(for f in /tmp/idem[1-5].out; do python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])' < "$f"; done | sort -u | wc -l | tr -d ' ') 1
IJ=$(cat /tmp/idem1.out | jget 'd["id"]')
CR1=$(curl -s -b $U1 $B/api/me | jget 'd["user"]["credits"]')
check "idempotency: charged once" $((CR0-CR1)) $(curl -s -b $U1 $B/api/options | jget 'd["prices"]["standard"]')
check "idempotency: one reserve ledger row" $(curl -s -b $U1 $B/api/credits/ledger | python3 -c "import sys,json;print(sum(1 for r in json.load(sys.stdin) if r['job_id']=='$IJ' and r['reason']=='reserve'))") 1
check "idempotency: replay later returns same job" $(curl -s -b $U1 "${H[@]}" -H "Idempotency-Key: $IK" -X POST $B/api/jobs -d "$JB" | jget "d['id']=='$IJ'") True
check "idempotency: same key, different body → 409" $(code -b $U1 "${H[@]}" -H "Idempotency-Key: $IK" -X POST $B/api/jobs -d "{\"projectId\":\"$P1\",\"prompt\":\"other\",\"ratios\":[\"1:1\"],\"perRatio\":1}") 409
check "idempotency: non-uuid key → 400" $(code -b $U1 "${H[@]}" -H "Idempotency-Key: abc" -X POST $B/api/jobs -d "$JB") 400
check "job items carry expiresAt" $(curl -s -b $U1 $B/api/jobs/$IJ | jget '"expired" in d["items"][0] and "expiresAt" in d["items"][0]') True
# --- admin password reset (uses user2): temp password once, sessions revoked, forced change
U2ID=$(curl -s -b $U2 $B/api/me | jget 'd["user"]["id"]'); U2EM=$(curl -s -b $U2 $B/api/me | jget 'd["user"]["email"]')
check "user cannot reset passwords" $(code -b $U1 "${H[@]}" -X POST $B/api/admin/users/$U2ID/reset-password -d '{}') 403
ADMID=$(curl -s -b $A $B/api/me | jget 'd["user"]["id"]')
check "admin cannot reset own password" $(code -b $A "${H[@]}" -X POST $B/api/admin/users/$ADMID/reset-password -d '{}') 400
TMP=$(curl -s -b $A "${H[@]}" -X POST $B/api/admin/users/$U2ID/reset-password -d '{}' | jget 'd["tempPassword"]')
check "reset returns strong temp password" $([[ ${#TMP} -ge 20 ]] && echo ok) ok
check "reset revokes existing sessions" $(code -b $U2 $B/api/projects) 401
check "temp password not in audit log" $(curl -s -b $A $B/api/admin/audit | grep -c -- "$TMP") 0
U2A=/tmp/s2a.jar; U2B=/tmp/s2b.jar; rm -f $U2A $U2B
check "login with temp password" $(code -c $U2A "${H[@]}" -X POST $B/api/auth/login -d "{\"email\":\"$U2EM\",\"password\":\"$TMP\"}") 200
curl -s -c $U2B "${H[@]}" -X POST $B/api/auth/login -d "{\"email\":\"$U2EM\",\"password\":\"$TMP\"}" >/dev/null
check "/api/me mustChangePassword" $(curl -s -b $U2A $B/api/me | jget 'd["user"]["mustChangePassword"]') True
check "must_change_password blocks app API" $(curl -s -b $U2A $B/api/projects | jget 'd["error"]') must_change_password
check "must_change_password blocks writes" $(code -b $U2A "${H[@]}" -X POST $B/api/projects -d '{"mode":"simple"}') 403
check "change password succeeds" $(code -b $U2A -c $U2A "${H[@]}" -X POST $B/api/auth/password -d "{\"current\":\"$TMP\",\"next\":\"password-2-new\"}") 200
check "change password revokes other sessions" $(code -b $U2B $B/api/projects) 401
check "after change: unblocked" $(code -b $U2A $B/api/projects) 200
check "after change: flag cleared" $(curl -s -b $U2A $B/api/me | jget 'd["user"]["mustChangePassword"]') False
# invite race: 1 code, 5 parallel registrations
C3=$(curl -s -b $A "${H[@]}" -X POST $B/api/admin/invites -d '{"count":1,"credits":1,"batch":"race"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["codes"][0])')
rm -f /tmp/race*.out
for i in 1 2 3 4 5; do curl -s "${H[@]}" -X POST $B/api/auth/register -d "{\"email\":\"race$i$RANDOM@t.local\",\"password\":\"password-x\",\"inviteCode\":\"$C3\"}" -o /tmp/race$i.out & done; wait
check "invite race: exactly one success" $(cat /tmp/race*.out | grep -o '"ok":true' | wc -l | tr -d ' ') 1
# login lockout
for i in $(seq 1 11); do curl -s -o /dev/null "${H[@]}" -X POST $B/api/auth/login -d '{"email":"lockme@t.local","password":"wrong"}'; done
check "login lockout / rate limit" $(code "${H[@]}" -X POST $B/api/auth/login -d '{"email":"lockme@t.local","password":"wrong"}') 429
check "security headers (CSP)" $(curl -sI $B/api/health | grep -ci content-security-policy) 1
check "cookie httpOnly+SameSite" $(grep -c -E 'HttpOnly|#HttpOnly' $U1) 1
echo "== $pass passed, $fail failed"
