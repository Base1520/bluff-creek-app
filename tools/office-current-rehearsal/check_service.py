#!/usr/bin/env python3
"""Bounded HTTP smoke for the NEW current-baseline local stack. Never hosted.

Only CLI: --run --stdin. Credentials, generated identities and HTTP/SQL bodies
remain in memory. This is neither a restore runner nor a general SQL/API client.
"""
import base64
import datetime
import http.client
import json
import os
import pwd
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time
import uuid

ORIGIN = "http://127.0.0.1:55521"
PROJECT = "bcbc-office-current-rehearsal-v2"
DOCKER = "/opt/homebrew/bin/docker"
SOCKET = "/private/tmp/bcbc-office-im-x20/colima/office/docker.sock"
PHYSICAL_SOCKET = pwd.getpwuid(os.getuid()).pw_dir + "/Documents/Codex/2026-09-04/im-x20/work/office-runtime/colima/office/docker.sock"
HOST = "unix://" + SOCKET
VERSIONS = ["20260908220558", "20260908220613", "20260908220623", "20260908220645", "20260908220658", "20260908220707", "20260908220718"]
REVISION = "20260907174301"
ROLES = ("admin", "editor", "viewer", "nonstaff")
CONTAINERS = {"db": ("5432/tcp", "55522"), "kong": ("8000/tcp", "55521"), "inbucket": ("8025/tcp", "55524")}
INPUT_LIMIT = 32768


class Refusal(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise Refusal(code)


def safe_error(error):
    return error.code if isinstance(error, Refusal) and re.fullmatch(r"[A-Z_]{1,80}", error.code) else "UNEXPECTED_FAILURE_REDACTED"


def parse_args(args):
    require(args == ["--run", "--stdin"], "EXACT_USAGE_REQUIRED")


def validate_environment(env):
    # http.client never consults proxies, and subprocess has a constructed env.
    # Refuse their presence anyway so a caller cannot mistake an override as used.
    for key, value in env.items():
        if not value:
            continue
        lowered = key.lower()
        require(not lowered.endswith("_proxy") and lowered != "all_proxy", "PROXY_OVERRIDE_REFUSED")
        require(not key.startswith(("DOCKER_", "PYTHON", "DYLD_", "LD_PRELOAD"))
                and key not in ("NODE_DEBUG", "NODE_DEBUG_NATIVE"), "DEBUG_OR_RUNTIME_OVERRIDE_REFUSED")


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_FIELD")
        result[key] = value
    return result


def read_config(stream):
    data = stream.read(INPUT_LIMIT + 1)
    require(len(data) <= INPUT_LIMIT, "INPUT_TOO_LARGE")
    try:
        value = json.loads(data, object_pairs_hook=_json_object)
    except Refusal:
        raise
    except Exception:
        raise Refusal("INVALID_INPUT_JSON") from None
    return validate_config(value)


def jwt_payload(key, expected_role):
    require(isinstance(key, str) and 20 <= len(key) <= 8192 and re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", key), "JWT_KEY_REQUIRED")
    try:
        segment = key.split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)), object_pairs_hook=_json_object)
    except Exception:
        raise Refusal("INVALID_KEY_JWT") from None
    require(isinstance(payload, dict) and payload.get("role") == expected_role, "WRONG_KEY_ACTOR")
    # Decode is only an actor sanity check. The actual local API must validate it.
    return payload


def validate_config(value):
    require(type(value) is dict and set(value) == {"url", "anonKey", "serviceKey", "allowSyntheticWrites"}, "EXACT_INPUT_FIELDS_REQUIRED")
    require(value["url"] == ORIGIN, "LOCAL_ORIGIN_REQUIRED")
    require(value["allowSyntheticWrites"] is True, "SYNTHETIC_WRITES_ACK_REQUIRED")
    jwt_payload(value["anonKey"], "anon")
    jwt_payload(value["serviceKey"], "service_role")
    require(value["anonKey"] != value["serviceKey"], "DISTINCT_KEYS_REQUIRED")
    return dict(value)


def validate_socket(info, physical, uid):
    require(stat.S_ISSOCK(info.st_mode) and not stat.S_ISLNK(info.st_mode)
            and info.st_uid == uid and physical == PHYSICAL_SOCKET, "TASK_SOCKET_UNVERIFIED")


def validate_inspection(data, kind):
    require(kind in CONTAINERS and type(data) is dict, "CONTAINER_UNVERIFIED")
    require(data.get("name") == "/supabase_" + kind + "_" + PROJECT
            and data.get("running") is True
            and type(data.get("labels")) is dict
            and data["labels"].get("com.supabase.cli.project") == PROJECT, "CONTAINER_UNVERIFIED")
    require(data.get("network_mode") != "host", "HOST_NETWORK_REFUSED")
    ports = data.get("ports")
    require(type(ports) is dict, "LOOPBACK_BINDING_UNVERIFIED")
    expected_port, expected_host = CONTAINERS[kind]
    exposed = {port: bindings for port, bindings in ports.items() if bindings is not None}
    require(exposed == {expected_port: [{"HostIp": "127.0.0.1", "HostPort": expected_host}]}, "LOOPBACK_BINDING_UNVERIFIED")


def fixture_id(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value), "INVALID_FIXTURE_ID")
    return value


class Registry:
    def __init__(self, run_id=None):
        self.run_id = fixture_id(run_id or str(uuid.uuid4()))
        self.users = {}

    def register(self, role, user_id):
        require(role in ROLES and role not in self.users, "INVALID_FIXTURE_ROLE")
        fixture_id(user_id)
        require(all(u["id"] != user_id for u in self.users.values()), "DUPLICATE_FIXTURE_ID")
        self.users[role] = {"id": user_id, "email": role + "-" + self.run_id + "@office-current-rehearsal.invalid", "token": None}
        return self.users[role]

    def owned(self, role):
        require(role in ROLES and role in self.users, "UNREGISTERED_FIXTURE_REFUSED")
        user = self.users[role]
        fixture_id(user["id"])
        require(user["email"] == role + "-" + self.run_id + "@office-current-rehearsal.invalid", "NON_SYNTHETIC_IDENTITY_REFUSED")
        return user


def fixture_statement(registry, action, role):
    require(action in ("assign", "revoke"), "FIXED_FIXTURE_OPERATION_REQUIRED")
    user = registry.owned(role)
    require(action != "assign" or role in ROLES[:3], "STAFF_FIXTURE_ROLE_REQUIRED")
    user_id, email = user["id"], user["email"]
    # UUID and exact generated .invalid email are validated before interpolation.
    identity = f"id = '{user_id}'::uuid and email = '{email}'"
    mutation = (f"insert into public.staff_roles(user_id, role) values ('{user_id}'::uuid, '{role}'::public.staff_role);"
                if action == "assign" else f"delete from public.staff_roles where user_id = '{user_id}'::uuid;")
    result = (f"select json_build_object('role', role) from public.staff_roles where user_id = '{user_id}'::uuid;"
              if action == "assign" else f"select json_build_object('remaining', count(*)) from public.staff_roles where user_id = '{user_id}'::uuid;")
    return f"""begin;
do $fixture$ begin
  if not exists (select 1 from auth.users where {identity}) then
    raise exception 'FIXTURE_IDENTITY_MISMATCH';
  end if;
  {mutation}
end $fixture$;
{result}
commit;
"""


CATALOG_SQL = """begin read only;
select json_build_object(
  'versions', (select json_agg(version order by version) from supabase_migrations.schema_migrations),
  'rls_tables', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity),
  'policies', (select count(*) from pg_policies where schemaname='public' or (schemaname='storage' and tablename='objects')),
  'auth_users', (select count(*) from auth.users),
  'staff_roles', (select count(*) from public.staff_roles),
  'contacts', (select count(*) from public.contacts),
  'objects', (select count(*) from storage.objects),
  'app_connections', (select count(*) from public.app_connections),
  'intake_entrypoints', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname='save_app_connection' and oidvectortypes(p.proargtypes)='text, text, text, text, boolean, text'),
  'intake_grants', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname in ('public','private') and p.proname='save_app_connection' and a.privilege_type='EXECUTE' and (a.grantee=0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated'))))
);
commit;
"""


def validate_catalog(data, virgin=False):
    require(type(data) is dict and data.get("versions") == VERSIONS
            and data.get("rls_tables") == 17 and data.get("policies") == 54,
            "CURRENT_BASELINE_CATALOG_MISMATCH")
    require(data.get("intake_entrypoints") == 2 and data.get("intake_grants") == 0
            and data.get("app_connections") == 0, "PUBLIC_INTAKE_NOT_PAUSED")
    if virgin:
        require(all(data.get(k) == 0 for k in ("auth_users", "staff_roles", "contacts", "objects")), "VIRGIN_STACK_REQUIRED")


class LocalStack:
    def _docker(self, args, stdin=None):
        # An empty private Docker config plus a constructed env prevents contexts,
        # user CLI configuration and proxy/env overrides from selecting a daemon.
        try:
            with tempfile.TemporaryDirectory(prefix="bcbc-current-docker-", dir="/private/tmp") as config:
                completed = subprocess.run([DOCKER, "--config", config, "--host", HOST] + args,
                    input=stdin, capture_output=True, timeout=15, text=True,
                    env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", "DOCKER_HOST": HOST})
            require(completed.returncode == 0, "FIXED_LOCAL_DOCKER_FAILED")
            require(len(completed.stdout) + len(completed.stderr) <= 131072, "LOCAL_OUTPUT_TOO_LARGE")
            return completed.stdout
        except Refusal:
            raise
        except Exception:
            raise Refusal("FIXED_LOCAL_DOCKER_FAILED") from None

    def verify(self):
        try:
            validate_socket(os.lstat(SOCKET), os.path.realpath(SOCKET), os.getuid())
        except Refusal:
            raise
        except Exception:
            raise Refusal("TASK_SOCKET_UNAVAILABLE") from None
        fmt = '{"name":{{json .Name}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"ports":{{json .NetworkSettings.Ports}},"network_mode":{{json .HostConfig.NetworkMode}}}'
        for kind in CONTAINERS:
            try:
                data = json.loads(self._docker(["inspect", "--format", fmt, "supabase_" + kind + "_" + PROJECT]))
            except Refusal:
                raise
            except Exception:
                raise Refusal("CONTAINER_INSPECTION_INVALID") from None
            validate_inspection(data, kind)

    def _sql(self, text):
        self.verify()
        output = self._docker(["exec", "-i", "supabase_db_" + PROJECT, "psql", "-X", "--no-password",
            "--username=postgres", "--dbname=postgres", "--set=ON_ERROR_STOP=1", "--set=VERBOSITY=sqlstate",
            "--tuples-only", "--no-align", "--quiet"], text)
        try:
            return json.loads(output)
        except Exception:
            raise Refusal("FIXED_SQL_RESULT_UNCONFIRMED") from None

    def catalog(self):
        return self._sql(CATALOG_SQL)

    def role(self, registry, action, role):
        result = self._sql(fixture_statement(registry, action, role))
        require(result == ({"role": role} if action == "assign" else {"remaining": 0}), "FIXTURE_ROLE_CHANGE_UNCONFIRMED")


def safe_http(response):
    # Only fixed, recognized codes; arbitrary server diagnostics never leave RAM.
    result = {"http_status": response["status"]}
    code = response.get("data", {}).get("code") if type(response.get("data")) is dict else None
    if code in {"42501", "40001", "23505", "PGRST301", "PGRST302", "PGRST202", "bad_jwt", "not_admin", "email_provider_disabled"}:
        result["api_code"] = code
    return result


class LocalApi:
    def __init__(self, config, stack):
        self.config = validate_config(config)
        self.stack = stack
        self.last = None

    def request(self, path, actor="anon", token=None, method="GET", body=None):
        require(isinstance(path, str) and re.fullmatch(r"/(?:auth|rest)/v1/[A-Za-z0-9_/?=&.,*-]+", path)
                and "//" not in path and ".." not in path, "FIXED_LOCAL_PATH_REQUIRED")
        require(method in ("GET", "POST", "PATCH", "PUT") and actor in ("anon", "service", "user"), "FIXED_HTTP_OPERATION_REQUIRED")
        if method != "GET":
            self.stack.verify()
        key = self.config["serviceKey" if actor == "service" else "anonKey"]
        if actor == "user":
            require(isinstance(token, str) and 20 <= len(token) <= 16384 and not re.search(r"\s", token), "SESSION_TOKEN_REQUIRED")
        headers = {"apikey": key, "Authorization": "Bearer " + (token if actor == "user" else key), "Prefer": "return=representation"}
        encoded = json.dumps(body).encode() if body is not None else None
        if encoded is not None:
            require(len(encoded) <= 32768, "REQUEST_TOO_LARGE")
            headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection("127.0.0.1", 55521, timeout=15)
        try:
            connection.request(method, path, body=encoded, headers=headers)
            response = connection.getresponse()
            require(not 300 <= response.status < 400, "REDIRECT_REFUSED")
            raw = response.read(1048577)
            require(len(raw) <= 1048576, "RESPONSE_TOO_LARGE")
            try:
                data = json.loads(raw) if raw else None
            except Exception:
                raise Refusal("JSON_HTTP_RESPONSE_REQUIRED") from None
            self.last = {"status": response.status, "data": data}
            return self.last
        except Refusal:
            raise
        except Exception:
            raise Refusal("LOCAL_HTTP_UNCONFIRMED") from None
        finally:
            connection.close()


def single(response):
    require(200 <= response["status"] < 300 and type(response["data"]) is list and len(response["data"]) == 1, "EXPECTED_SINGLE_ROW")
    return response["data"][0]


def empty(response):
    require(200 <= response["status"] < 300 and response["data"] == [], "EXPECTED_EMPTY_VISIBLE_ROWS")


def denied(response):
    # 404, 500, network failures, invalid JWTs and empty responses aren't proof.
    require(response["status"] in (401, 403) and type(response["data"]) is dict
            and response["data"].get("code") == "42501", "EXPECTED_PERMISSION_DENIAL")


def owned_auth(response, user):
    data = response["data"]
    owned = data.get("user", data) if type(data) is dict else None
    require(200 <= response["status"] < 300 and type(owned) is dict
            and owned.get("id") == user["id"] and owned.get("email") == user["email"], "AUTH_FIXTURE_IDENTITY_UNCONFIRMED")
    return owned


def validate_auth_settings(response):
    data = response.get("data")
    require(response.get("status") == 200 and type(data) is dict
            and data.get("disable_signup") is True
            and type(data.get("external")) is dict
            and data["external"].get("email") is True, "LOCAL_AUTH_SETTINGS_UNCONFIRMED")


def run(config):
    stack = LocalStack()
    api = LocalApi(config, stack)
    registry = Registry()
    report = {"kind": "current-seven-local-http-smoke", "origin": ORIGIN, "checks": [], "cleanup": [],
              "limits": ["Local services only; no hosted, email delivery, backup restore, browser, or phone acceptance.",
                         "Current seven migrations only; optional Auth guard remains unapplied.",
                         "Fictional contact, audit history, and banned Auth identities are retained."]}

    def mark(name):
        report["checks"].append({"check": name, "status": "passed"})

    def rpc(role, name, body=None):
        return api.request("/rest/v1/rpc/" + name, "user", registry.owned(role)["token"], "POST", body or {})

    def readiness(role):
        response = rpc(role, "office_readiness")
        require(response["status"] == 200 and type(response["data"]) is dict
                and response["data"].get("schema_revision") == REVISION and response["data"].get("staff_role") == role, "STAFF_READINESS_UNCONFIRMED")

    def contact(role, contact_id, method="GET", version=None, body=None):
        path = "/rest/v1/contacts?id=eq." + fixture_id(contact_id) + "&select=*"
        if version is not None:
            require(type(version) is int and version in (1, 2), "FIXTURE_VERSION_REQUIRED")
            path += "&version=eq." + str(version)
        return api.request(path, "user", registry.owned(role)["token"], method, body)

    try:
        validate_catalog(stack.catalog(), virgin=True)
        validate_auth_settings(api.request("/auth/v1/settings"))
        mark("exact new local topology, virgin seven-migration catalog and closed-signup email provider")
        for role in ROLES:
            user = registry.register(role, str(uuid.uuid4()))
            password = secrets.token_urlsafe(48)
            created = owned_auth(api.request("/auth/v1/admin/users", "service", method="POST", body={
                "id": user["id"], "email": user["email"], "password": password, "email_confirm": True,
                "user_metadata": {"role": "admin", "staff_role": "admin"} if role == "nonstaff" else {"synthetic": True}}), user)
            require(bool(created.get("email_confirmed_at")), "AUTH_CONFIRMATION_UNCONFIRMED")
            session = api.request("/auth/v1/token?grant_type=password", method="POST", body={"email": user["email"], "password": password})
            owned_auth(session, user)
            require(type(session["data"].get("access_token")) is str, "PASSWORD_SESSION_UNCONFIRMED")
            user["token"] = session["data"]["access_token"]
            if role != "nonstaff":
                stack.role(registry, "assign", role)
        mark("four confirmed fictional Auth users and actual password sessions")
        for role in ROLES[:3]:
            readiness(role)
        denied(api.request("/rest/v1/rpc/office_readiness", method="POST", body={}))
        denied(rpc("nonstaff", "office_readiness"))
        readiness("admin")
        mark("staff readiness positive controls and anonymous/nonstaff permission denials")

        contact_id = str(uuid.uuid4())
        inserted = single(api.request("/rest/v1/contacts?select=*", "user", registry.owned("admin")["token"], "POST",
            {"id": contact_id, "first_name": "Fictional", "last_name": "Current Rehearsal", "status": "visitor", "version": 999, "notes": "Synthetic current-baseline fixture."}))
        require(inserted.get("id") == contact_id and inserted.get("version") == 1
                and inserted.get("created_by") == registry.owned("admin")["id"], "SERVER_CONTACT_FIELDS_UNCONFIRMED")
        for role in ROLES[:3]:
            require(single(contact(role, contact_id)).get("id") == contact_id, "STAFF_CONTACT_READ_UNCONFIRMED")
        empty(contact("nonstaff", contact_id))
        denied(api.request("/rest/v1/contacts?id=eq." + contact_id + "&select=*"))
        mark("admin contact creation and staff/nonstaff visibility controls")

        updated = single(contact("editor", contact_id, "PATCH", 1, {"notes": "Synthetic editor update."}))
        require(updated.get("version") == 2 and updated.get("notes") == "Synthetic editor update."
                and updated.get("updated_by") == registry.owned("editor")["id"], "EDITOR_VERSIONED_SAVE_UNCONFIRMED")
        mark("editor optimistic update and server version advancement")
        empty(contact("viewer", contact_id, "PATCH", 2, {"notes": "Must not save viewer change."}))
        empty(contact("editor", contact_id, "PATCH", 1, {"notes": "Must not save stale change."}))
        preserved = single(contact("admin", contact_id))
        require(preserved.get("version") == 2 and preserved.get("notes") == "Synthetic editor update.", "DENIED_OR_STALE_WRITE_CHANGED_CONTACT")
        mark("viewer and stale-version updates cannot overwrite saved contact")

        outsider = registry.owned("nonstaff")
        denied(api.request("/rest/v1/staff_roles?select=*", "user", outsider["token"], "POST", {"user_id": outsider["id"], "role": "admin"}))
        empty(api.request("/rest/v1/staff_roles?select=user_id,role", "user", outsider["token"]))
        denied(rpc("nonstaff", "office_readiness"))
        readiness("editor")
        mark("authenticated self-promotion and user-editable admin metadata grant no staff role")

        payload = {"p_first_name": "Fictional", "p_last_name": "Intake Paused", "p_phone": None,
                   "p_preferred_contact": "email", "p_contact_permission": True, "p_sunday_school": None}
        # Positive controls: the same authenticated caller can read its own empty
        # profile; both RPCs exist in the fixed catalog; staff readiness still works.
        own = rpc("nonstaff", "get_my_app_connection")
        require(own["status"] == 200 and own["data"] is None, "OWN_PROFILE_CONTROL_UNCONFIRMED")
        denied(rpc("nonstaff", "save_app_connection", payload))
        denied(api.request("/rest/v1/rpc/save_app_connection", method="POST", body=payload))
        validate_catalog(stack.catalog())
        readiness("admin")
        mark("public and private intake entrypoints remain paused with zero submitted profiles")

        stack.role(registry, "revoke", "editor")
        denied(rpc("editor", "office_readiness"))
        empty(contact("editor", contact_id))
        readiness("admin")
        readiness("viewer")
        mark("role revocation removes access using the existing session")
    except Exception as error:
        failed = {"check": "current local service smoke", "status": "failed", "error": safe_error(error)}
        if api.last:
            failed.update(safe_http(api.last))
        report["checks"].append(failed)
    finally:
        for role in ROLES:
            if role not in registry.users:
                continue
            actions = {}
            try:
                user = registry.owned(role)
                owned_auth(api.request("/auth/v1/admin/users/" + user["id"], "service"), user)
                try:
                    stack.role(registry, "revoke", role)
                    actions["role_revocation"] = "confirmed"
                except Exception as error:
                    actions["role_revocation"] = safe_error(error)
                try:
                    if user["token"]:
                        response = api.request("/auth/v1/logout?scope=global", "user", user["token"], "POST")
                        require(200 <= response["status"] < 300, "LOGOUT_UNCONFIRMED")
                        actions["session_logout"] = "confirmed"
                    else:
                        actions["session_logout"] = "no_session_obtained"
                except Exception as error:
                    actions["session_logout"] = safe_error(error)
                try:
                    # Re-read the exact registered ID/email immediately before ban.
                    owned_auth(api.request("/auth/v1/admin/users/" + user["id"], "service"), user)
                    banned = owned_auth(api.request("/auth/v1/admin/users/" + user["id"], "service", method="PUT", body={"ban_duration": "87600h"}), user)
                    until = datetime.datetime.fromisoformat(banned.get("banned_until", "").replace("Z", "+00:00"))
                    require(until.timestamp() > time.time(), "BAN_UNCONFIRMED")
                    actions["auth_ban"] = "confirmed"
                except Exception as error:
                    actions["auth_ban"] = safe_error(error)
            except Exception as error:
                actions["identity_check"] = safe_error(error)
            complete = actions.get("role_revocation") == "confirmed" and actions.get("auth_ban") == "confirmed" and actions.get("session_logout") in ("confirmed", "no_session_obtained")
            report["cleanup"].append({"actor": role, "status": "access_containment_confirmed" if complete else "unconfirmed", "actions": actions})
        if registry.users:
            try:
                final = stack.catalog()
                validate_catalog(final)
                require(final.get("staff_roles") == 0 and final.get("objects") == 0, "FINAL_FIXTURE_CONTAINMENT_UNCONFIRMED")
                mark("final paused-intake catalog and zero fixture staff roles")
            except Exception as error:
                report["checks"].append({"check": "final local catalog", "status": "failed", "error": safe_error(error)})
    report["passed"] = sum(item["status"] == "passed" for item in report["checks"])
    report["failed"] = sum(item["status"] == "failed" for item in report["checks"])
    report["cleanup_unconfirmed"] = sum(item["status"] == "unconfirmed" for item in report["cleanup"])
    report["status"] = "passed_local_http_only" if not report["failed"] and not report["cleanup_unconfirmed"] and len(report["cleanup"]) == 4 else "failed_or_incomplete"
    return report


def main():
    try:
        require(sys.version_info >= (3, 11), "PYTHON_VERSION_REQUIRED")
        parse_args(sys.argv[1:])
        validate_environment(os.environ)
        require(not sys.stdin.isatty(), "PIPE_JSON_INPUT_REQUIRED")
        report = run(read_config(sys.stdin.buffer))
        print(json.dumps(report, indent=2))
        return 0 if report["status"] == "passed_local_http_only" else 1
    except Exception as error:
        print(json.dumps({"status": "refused_or_failed", "error": safe_error(error)}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
