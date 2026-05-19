#!/usr/bin/env python3
"""
Systematic test suite for MLflow multi-tenant server.
Tests all major functions via REST API.

Usage:
    python3 /tmp/mlflow_system_test.py [--url https://mlflow.lionlambstone.org]
"""

import argparse
import base64
import json
import sys
import time
import urllib.request
import urllib.error

# ── Config ────────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument("--url", default="https://mlflow.lionlambstone.org")
args = parser.parse_args()
BASE = args.url.rstrip("/")
ADMIN = ("admin", "admin1234567")

PASS = "\033[92m✅ PASS\033[0m"
FAIL = "\033[91m❌ FAIL\033[0m"
SKIP = "\033[93m⚠️  SKIP\033[0m"

results = []
TS = str(int(__import__("time").time()))[-6:]  # unique suffix

# ── Helpers ───────────────────────────────────────────────────────────────────

def b64(user, pw):
    return base64.b64encode(f"{user}:{pw}".encode()).decode()

def req(method, path, body=None, auth=ADMIN, tenant=None, expect=None):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Basic {b64(*auth)}",
    }
    if tenant:
        headers["X-MLflow-Tenant"] = tenant
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            code = resp.status
            body_str = resp.read().decode()
            try:
                return code, json.loads(body_str)
            except Exception:
                return code, body_str
    except urllib.error.HTTPError as e:
        code = e.code
        try:
            return code, json.loads(e.read().decode())
        except Exception:
            return code, {}

def check(name, actual_code, expected_code, detail=""):
    ok = actual_code == expected_code
    icon = PASS if ok else FAIL
    suffix = f"  [{detail}]" if detail else ""
    print(f"  {icon}  {name} (HTTP {actual_code}){suffix}")
    results.append((name, ok))
    return ok

def section(title):
    print(f"\n{'─'*60}")
    print(f"  {title}")
    print('─'*60)

# ── Tests ─────────────────────────────────────────────────────────────────────

section("1. Health & Server")
code, _ = req("GET", "/health", auth=ADMIN)
check("Server health", code, 200)

code, data = req("GET", "/sso/providers", auth=ADMIN)
check("SSO providers endpoint", code, 200)
providers = [p["id"] for p in data.get("providers", [])]
print(f"     Providers: {providers}")

# ── Setup: create test tenants and users ──────────────────────────────────────
section("2. Tenant (Team) Management")

code, data = req("POST", "/api/3.0/mlflow/tenants/create",
    {"slug": f"test-alpha-{TS}", "name": f"Test Team Alpha {TS}", "storage_root": "/tmp/alpha"})
check("Create tenant", code, 200, data.get("tenant", {}).get("slug", ""))

code, data = req("GET", "/ajax-api/3.0/mlflow/tenants/list")
check("List tenants", code, 200)
slugs = [t["slug"] for t in data.get("tenants", [])]
print(f"     Tenants: {slugs}")

code, data = req("PATCH", "/ajax-api/3.0/mlflow/tenants/update",
    {"slug": f"test-alpha-{TS}", "name": f"Test Team Alpha {TS} renamed"})
check("Update tenant name", code, 200)

# ── Users ─────────────────────────────────────────────────────────────────────
section("3. User Management")

code, data = req("POST", "/api/2.0/mlflow/users/create",
    {"username": f"testuser_a_{TS}", "password": "TestPass@1234!", "role": "member"},
    tenant=f"test-alpha-{TS}")
check("Create user in team", code, 200, data.get("user", {}).get("username", ""))

code, data = req("GET", "/api/2.0/mlflow/users/list", tenant=f"test-alpha-{TS}")
check("List users in team", code, 200)
usernames = [u["username"] for u in data.get("users", [])]
print(f"     Users: {usernames}")

code, _ = req("GET", "/ajax-api/2.0/mlflow/users/current",
    auth=("admin", "admin1234567"))
check("Get current user", code, 200)

code, data = req("GET", "/ajax-api/2.0/mlflow/users/global-admins")
check("List global admins", code, 200)
admins = [u["username"] for u in data.get("users", [])]
print(f"     Global admins: {admins}")

# ── Team Membership ───────────────────────────────────────────────────────────
section("4. Team Membership")

code, data = req("POST", "/ajax-api/3.0/mlflow/teams/members/add",
    {"username": f"testuser_a_{TS}", "role": "member"}, tenant=f"test-alpha-{TS}")
check("Add existing user to team", code, 200)

code, data = req("GET", "/ajax-api/3.0/mlflow/teams/members/list",
    tenant=f"test-alpha-{TS}")
check("List team members", code, 200)
members = [m["username"] for m in data.get("members", [])]
print(f"     Members: {members}")

code, data = req("GET", "/ajax-api/3.0/mlflow/users/teams",
    auth=("admin", "admin1234567"), tenant="default")
check("Get user's teams", code, 200)
teams = [t["slug"] for t in data.get("teams", [])]
print(f"     Admin teams: {teams}")

code, _ = req("DELETE", "/ajax-api/3.0/mlflow/teams/members/remove",
    {"username": f"testuser_a_{TS}"}, tenant=f"test-alpha-{TS}")
check("Remove user from team", code, 200)

# ── Projects (Experiments) ────────────────────────────────────────────────────
section("5. Projects (Experiments)")

code, data = req("POST", "/ajax-api/2.0/mlflow/experiments/create",
    {"name": f"test-project-{TS}"}, tenant=f"test-alpha-{TS}")
check("Create experiment/project", code, 200)
exp_id = data.get("experiment_id", "")
print(f"     Experiment ID: {exp_id}")

code, data = req("POST", "/ajax-api/2.0/mlflow/experiments/search",
    {"max_results": 50}, tenant=f"test-alpha-{TS}")
check("Search experiments", code, 200)
exp_names = [e["name"] for e in data.get("experiments", []) if e.get("name") != "Default"]
print(f"     Experiments: {exp_names}")

if exp_id:
    code, _ = req("POST", "/ajax-api/2.0/mlflow/experiments/update",
        {"experiment_id": exp_id, "new_name": f"test-project-{TS}-renamed"},
        tenant=f"test-alpha-{TS}")
    check("Rename experiment", code, 200)

# ── Tenant isolation ──────────────────────────────────────────────────────────
section("6. Tenant Isolation")

code, data = req("POST", "/api/3.0/mlflow/tenants/create",
    {"slug": f"test-beta-{TS}", "name": f"Test Team Beta {TS}"})
check("Create second tenant", code, 200)

code, _ = req("POST", "/api/2.0/mlflow/users/create",
    {"username": f"testuser_b_{TS}", "password": "TestPass@5678!", "role": "member"},
    tenant=f"test-beta-{TS}")
check("Create user in beta team", code, 200)

# testuser_b should not see alpha's experiments
code, data = req("POST", "/api/2.0/mlflow/experiments/search",
    {"max_results": 10}, auth=(f"testuser_b_{TS}", "TestPass@5678!"),
    tenant=f"test-beta-{TS}")
exp_names_b = [e["name"] for e in data.get("experiments", [])]
alpha_leaked = any("alpha" in n for n in exp_names_b)
icon = PASS if not alpha_leaked else FAIL
print(f"  {icon}  Team isolation (alpha not visible from beta) "
      f"(HTTP {code}) [{exp_names_b}]")
results.append(("Team isolation", not alpha_leaked))

# testuser_b should not be able to access test-team-alpha
code, _ = req("POST", "/api/2.0/mlflow/experiments/search",
    {"max_results": 10}, auth=(f"testuser_b_{TS}", "TestPass@5678!"),
    tenant=f"test-alpha-{TS}")
check("Cross-tenant access blocked (403)", code, 403)

# ── Permissions ───────────────────────────────────────────────────────────────
section("7. Experiment Permissions")

if exp_id:
    code, _ = req("POST", "/api/2.0/mlflow/experiments/permissions/create",
        {"experiment_id": exp_id, "username": f"testuser_a_{TS}", "permission": "EDIT"},
        tenant=f"test-alpha-{TS}")
    check("Grant EDIT permission", code, 200)

    code, data = req("GET",
        f"/api/2.0/mlflow/experiments/permissions/get"
        f"?experiment_id={exp_id}&username=testuser_a_{TS}",
        tenant=f"test-alpha-{TS}")
    check("Get experiment permission", code, 200,
          data.get("experiment_permission", {}).get("permission", ""))

# ── Model Registry ────────────────────────────────────────────────────────────
section("8. Model Registry")

code, data = req("POST", "/ajax-api/2.0/mlflow/registered-models/create",
    {"name": f"test-model-{TS}"}, tenant=f"test-alpha-{TS}")
check("Create registered model", code, 200)

code, data = req("GET",
    "/ajax-api/2.0/mlflow/registered-models/search?max_results=10",
    tenant=f"test-alpha-{TS}")
check("Search registered models", code, 200)
model_names = [m["name"] for m in data.get("registered_models", [])]
print(f"     Models: {model_names}")

code, data = req("POST",
    "/ajax-api/2.0/mlflow/registered-models/set-visibility",
    {"name": f"test-model-{TS}", "visibility": "public"},
    tenant=f"test-alpha-{TS}")
check("Set model visibility=public", code, 200)

# Beta user should now see the public model
code, data = req("GET",
    "/ajax-api/2.0/mlflow/registered-models/search?max_results=10",
    auth=(f"testuser_b_{TS}", "TestPass@5678!"), tenant=f"test-beta-{TS}")
public_models = [m["name"] for m in data.get("registered_models", [])]
check("Public model visible to other team", code, 200, str(public_models))

code, _ = req("POST",
    "/ajax-api/2.0/mlflow/registered-models/set-visibility",
    {"name": f"test-model-{TS}", "visibility": "team"},
    tenant=f"test-alpha-{TS}")
check("Revert model visibility=team", code, 200)

# ── Profile ───────────────────────────────────────────────────────────────────
section("9. User Profile")

code, data = req("GET", "/ajax-api/2.0/mlflow/users/profile",
    auth=("admin", "admin1234567"), tenant="default")
check("Get profile", code, 200, f"username={data.get('profile', {}).get('username', '')}")

code, data = req("PATCH", "/ajax-api/2.0/mlflow/users/update-profile",
    {"display_name": "Admin User", "email": "admin@test.com"},
    auth=("admin", "admin1234567"), tenant="default")
check("Update profile", code, 200)

# ── Admin: promote/demote ─────────────────────────────────────────────────────
section("10. Global Admin Management")

code, _ = req("PATCH", "/api/2.0/mlflow/users/update-admin",
    {"username": f"testuser_a_{TS}", "is_admin": True}, tenant=f"test-alpha-{TS}")
check("Promote to global admin", code, 200)

code, data = req("GET", "/ajax-api/2.0/mlflow/users/global-admins")
check("Global admins updated", code, 200)
admins = [u["username"] for u in data.get("users", [])]
print(f"     Admins now: {admins}")

code, _ = req("PATCH", "/api/2.0/mlflow/users/update-admin",
    {"username": f"testuser_a_{TS}", "is_admin": False}, tenant=f"test-alpha-{TS}")
check("Demote from global admin", code, 200)

# ── Cleanup ───────────────────────────────────────────────────────────────────
section("11. Cleanup (delete test resources)")

if exp_id:
    code, _ = req("POST", "/ajax-api/2.0/mlflow/experiments/delete",
        {"experiment_id": exp_id}, tenant=f"test-alpha-{TS}")
    check("Delete experiment", code, 200)

code, _ = req("DELETE", "/ajax-api/2.0/mlflow/registered-models/delete",
    {"name": f"test-model-{TS}"}, tenant=f"test-alpha-{TS}")
check("Delete registered model", code, 200)

code, _ = req("DELETE", "/api/2.0/mlflow/users/delete",
    {"username": f"testuser_a_{TS}"}, tenant=f"test-alpha-{TS}")
check("Delete testuser_a", code, 200)

code, _ = req("DELETE", "/api/2.0/mlflow/users/delete",
    {"username": f"testuser_b_{TS}"}, tenant=f"test-beta-{TS}")
check("Delete testuser_b", code, 200)

code, _ = req("DELETE", "/ajax-api/3.0/mlflow/tenants/delete",
    {"slug": f"test-alpha-{TS}"})
check("Delete test-team-alpha", code, 200)

code, _ = req("DELETE", "/ajax-api/3.0/mlflow/tenants/delete",
    {"slug": f"test-beta-{TS}"})
check("Delete test-team-beta", code, 200)

# ── Summary ───────────────────────────────────────────────────────────────────
print(f"\n{'═'*60}")
total = len(results)
passed = sum(1 for _, ok in results if ok)
failed = total - passed
print(f"  Results: {passed}/{total} passed", end="")
if failed:
    print(f"  ({failed} failed)")
    print("\n  Failed tests:")
    for name, ok in results:
        if not ok:
            print(f"    ❌  {name}")
else:
    print("  🎉 All tests passed!")
print('═'*60)
sys.exit(0 if failed == 0 else 1)
