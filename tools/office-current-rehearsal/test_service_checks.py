"""Pure safety and result interpretation tests; no Docker or HTTP execution."""
import base64
import copy
import io
import json
import stat
import types
import unittest
from unittest import mock

import check_service as c


RUN = "6d0333a8-58b0-44ea-9a37-6a5c6dbead27"
USER = "bbdb80fa-cf91-47c1-9622-7e77fa446c9b"


def jwt(role):
    def encoded(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    return encoded({"alg": "HS256"}) + "." + encoded({"role": role}) + "." + "fictionalsignature"


def config():
    return {"url": c.ORIGIN, "anonKey": jwt("anon"), "serviceKey": jwt("service_role"), "allowSyntheticWrites": True}


def inspection(kind):
    port, host = c.CONTAINERS[kind]
    return {"name": "/supabase_" + kind + "_" + c.PROJECT, "running": True,
            "labels": {"com.supabase.cli.project": c.PROJECT}, "network_mode": "supabase_network_" + c.PROJECT,
            "ports": {port: [{"HostIp": "127.0.0.1", "HostPort": host}], "1234/tcp": None}}


def catalog():
    return {"versions": c.VERSIONS[:], "rls_tables": 17, "policies": 54,
            "auth_users": 0, "staff_roles": 0, "contacts": 0, "objects": 0,
            "app_connections": 0, "intake_entrypoints": 2, "intake_grants": 0}


class GuardTests(unittest.TestCase):
    def test_cli_is_stdin_only_and_never_accepts_overrides(self):
        c.parse_args(["--run", "--stdin"])
        for args in ([], ["--run"], ["--help"], ["--stdin", "--run"], ["--run", "--stdin", "--reset"], ["--run", "--stdin", "--url", c.ORIGIN]):
            with self.subTest(args=args), self.assertRaises(c.Refusal):
                c.parse_args(args)

    def test_only_exact_loopback_origin_is_accepted(self):
        c.validate_config(config())
        for url in ("https://project.supabase.co", "http://localhost:55521", "http://127.0.0.1:55321", "http://127.0.0.1:55521/", "http://127.0.0.1:55521@evil.invalid", "http://192.168.1.2:55521", "http://2130706433:55521", c.ORIGIN + "?url=https://evil.invalid"):
            value = config()
            value["url"] = url
            with self.subTest(url=url), self.assertRaises(c.Refusal):
                c.validate_config(value)

    def test_exact_fields_boolean_and_key_actors(self):
        bad = []
        for key, value in (("allowSyntheticWrites", 1), ("allowSyntheticWrites", "true"), ("anonKey", jwt("service_role")), ("serviceKey", jwt("anon")), ("anonKey", "sb_publishable_fictional_key"), ("serviceKey", "sb_secret_fictional_key")):
            changed = config()
            changed[key] = value
            bad.append(changed)
        bad.extend([dict(config(), sql="select 1"), {k: v for k, v in config().items() if k != "url"}, []])
        for value in bad:
            with self.subTest(kind=type(value).__name__), self.assertRaises(c.Refusal):
                c.validate_config(value)

    def test_input_size_duplicates_and_invalid_json_fail_without_echo(self):
        self.assertEqual(c.read_config(io.BytesIO(json.dumps(config()).encode())), config())
        for raw in (b"x" * (c.INPUT_LIMIT + 1), b'{"url":"secret-one","url":"secret-two"}', b'{"secret":"do-not-echo"', b'null'):
            with self.subTest(length=len(raw)), self.assertRaises(c.Refusal) as error:
                c.read_config(io.BytesIO(raw))
            self.assertNotIn("secret", c.safe_error(error.exception).lower())

    def test_proxy_debug_docker_and_loader_overrides_refused(self):
        c.validate_environment({"PATH": "/usr/bin:/bin", "TERM": "xterm", "NO_PROXY": ""})
        for key in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "NO_PROXY", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "PYTHONPATH", "PYTHONINSPECT", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "NODE_DEBUG"):
            with self.subTest(key=key), self.assertRaises(c.Refusal):
                c.validate_environment({key: "fictional-override"})

    def test_socket_requires_ownership_type_and_current_task_resolution(self):
        info = types.SimpleNamespace(st_mode=stat.S_IFSOCK | 0o600, st_uid=501)
        c.validate_socket(info, c.PHYSICAL_SOCKET, 501)
        bad = [(info, c.PHYSICAL_SOCKET, 502), (info, "/private/tmp/other.sock", 501),
               (types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=501), c.PHYSICAL_SOCKET, 501),
               (types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=501), c.PHYSICAL_SOCKET, 501)]
        for args in bad:
            with self.assertRaises(c.Refusal):
                c.validate_socket(*args)

    def test_every_container_requires_exact_project_loopback_and_no_extra_exposure(self):
        for kind in c.CONTAINERS:
            good = inspection(kind)
            c.validate_inspection(good, kind)
            mutations = []
            for field, value in (("name", "/supabase_db_bcbc-office-rehearsal"), ("running", False), ("labels", {}), ("network_mode", "host")):
                changed = copy.deepcopy(good)
                changed[field] = value
                mutations.append(changed)
            port, host = c.CONTAINERS[kind]
            for binding in ([{"HostIp": "0.0.0.0", "HostPort": host}], [{"HostIp": "::1", "HostPort": host}], [{"HostIp": "127.0.0.1", "HostPort": "55321"}], [{"HostIp": "127.0.0.1", "HostPort": host}] * 2, []):
                changed = copy.deepcopy(good)
                changed["ports"][port] = binding
                mutations.append(changed)
            extra = copy.deepcopy(good)
            extra["ports"]["9999/tcp"] = [{"HostIp": "127.0.0.1", "HostPort": "55529"}]
            mutations.append(extra)
            for value in mutations:
                with self.subTest(kind=kind), self.assertRaises(c.Refusal):
                    c.validate_inspection(value, kind)

    def test_virgin_catalog_refuses_old_extra_or_dirty_stack(self):
        c.validate_catalog(catalog(), virgin=True)
        for key, value in (("versions", c.VERSIONS[:-1]), ("versions", c.VERSIONS + ["20260909024020"]), ("rls_tables", 16), ("policies", 53), ("auth_users", 1), ("staff_roles", 1), ("contacts", 1), ("objects", 1), ("app_connections", 1), ("intake_entrypoints", 1), ("intake_grants", 1)):
            changed = catalog()
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(c.Refusal):
                c.validate_catalog(changed, virgin=True)
        retained = dict(catalog(), auth_users=4, contacts=1)
        c.validate_catalog(retained)

    def test_mail_binding_uses_observed_current_container_port(self):
        current = inspection("inbucket")
        current["ports"] = {"1025/tcp": None, "1110/tcp": None,
                            "8025/tcp": [{"HostIp": "127.0.0.1", "HostPort": "55524"}]}
        c.validate_inspection(current, "inbucket")
        current["ports"]["9000/tcp"] = current["ports"].pop("8025/tcp")
        with self.assertRaises(c.Refusal):
            c.validate_inspection(current, "inbucket")

    def test_previous_current_project_is_refused_after_fresh_v2_selection(self):
        for kind in c.CONTAINERS:
            previous = inspection(kind)
            previous["name"] = "/supabase_" + kind + "_bcbc-office-current-rehearsal"
            previous["labels"]["com.supabase.cli.project"] = "bcbc-office-current-rehearsal"
            with self.assertRaises(c.Refusal):
                c.validate_inspection(previous, kind)

    def test_auth_settings_require_closed_signup_and_enabled_email_provider(self):
        valid = {"status": 200, "data": {"disable_signup": True, "external": {"email": True}}}
        c.validate_auth_settings(valid)
        bad = [dict(valid, status=500), {"status": 200, "data": {}},
               {"status": 200, "data": {"disable_signup": False, "external": {"email": True}}},
               {"status": 200, "data": {"disable_signup": True, "external": {"email": False}}},
               {"status": 200, "data": {"disable_signup": True, "external": {"email": 1}}},
               {"status": 200, "data": {"disable_signup": 1, "external": {"email": True}}}]
        for response in bad:
            with self.assertRaises(c.Refusal):
                c.validate_auth_settings(response)

    def test_disabled_email_provider_stops_before_any_fixture_registration_or_write(self):
        stack = mock.Mock()
        stack.catalog.return_value = catalog()
        api = mock.Mock()
        api.last = None
        api.request.return_value = {"status": 200, "data": {"disable_signup": True, "external": {"email": False}}}
        with mock.patch.object(c, "LocalStack", return_value=stack), mock.patch.object(c, "LocalApi", return_value=api):
            result = c.run(config())
        self.assertEqual(result["status"], "failed_or_incomplete")
        self.assertEqual(result["cleanup"], [])
        self.assertEqual(result["checks"][0]["error"], "LOCAL_AUTH_SETTINGS_UNCONFIRMED")
        api.request.assert_called_once_with("/auth/v1/settings")
        stack.role.assert_not_called()

    def test_fixture_roles_bind_both_exact_registered_uuid_and_generated_email(self):
        registry = c.Registry(RUN)
        user = registry.register("admin", USER)
        for action in ("assign", "revoke"):
            sql = c.fixture_statement(registry, action, "admin")
            self.assertIn("if not exists (select 1 from auth.users where id = '" + USER + "'::uuid and email = '" + user["email"] + "')", sql)
            self.assertLess(sql.index("if not exists"), sql.index("insert into" if action == "assign" else "delete from"))
            self.assertNotIn("delete from auth.users", sql)
        for action, role in (("reset", "admin"), ("assign", "viewer"), ("drop", "admin")):
            with self.assertRaises(c.Refusal):
                c.fixture_statement(registry, action, role)
        user["email"] = "real-address@example.org"
        with self.assertRaises(c.Refusal):
            c.fixture_statement(registry, "revoke", "admin")

    def test_unregistered_injected_or_reused_ids_never_form_sql(self):
        registry = c.Registry(RUN)
        for value in (USER + "';delete from public.contacts;--", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", None):
            with self.assertRaises(c.Refusal):
                registry.register("admin", value)
        registry.register("admin", USER)
        with self.assertRaises(c.Refusal):
            registry.register("viewer", USER)
        registry.users["admin"]["id"] = USER + "'"
        with self.assertRaises(c.Refusal):
            c.fixture_statement(registry, "assign", "admin")

    def test_denial_requires_permission_code_not_failure_status(self):
        c.denied({"status": 403, "data": {"code": "42501"}})
        c.empty({"status": 200, "data": []})
        for response in ({"status": 500, "data": {"code": "42501"}}, {"status": 401, "data": {"code": "PGRST301"}}, {"status": 404, "data": {}}, {"status": 403, "data": {}}, {"status": 200, "data": []}):
            with self.assertRaises(c.Refusal):
                c.denied(response)
        with self.assertRaises(c.Refusal):
            c.empty({"status": 403, "data": []})

    def test_cleanup_identity_check_never_accepts_other_auth_user(self):
        registry = c.Registry(RUN)
        user = registry.register("admin", USER)
        valid = {"id": USER, "email": user["email"]}
        c.owned_auth({"status": 200, "data": valid}, user)
        c.owned_auth({"status": 200, "data": {"user": valid}}, user)
        for value in (dict(valid, id=RUN), dict(valid, email="other@office-current-rehearsal.invalid"), {}):
            with self.assertRaises(c.Refusal):
                c.owned_auth({"status": 200, "data": value}, user)

    def test_diagnostics_redact_unknown_error_and_server_fields(self):
        secret = "PRIVATE_SECRET_" + USER
        self.assertEqual(c.safe_error(RuntimeError(secret)), "UNEXPECTED_FAILURE_REDACTED")
        self.assertEqual(c.safe_http({"status": 403, "data": {"code": secret, "message": secret, "details": secret}}), {"http_status": 403})
        self.assertEqual(c.safe_http({"status": 403, "data": {"code": "42501", "message": secret}}), {"http_status": 403, "api_code": "42501"})
        self.assertEqual(c.safe_http({"status": 422, "data": {"code": "email_provider_disabled", "message": secret}}), {"http_status": 422, "api_code": "email_provider_disabled"})

    def test_http_refuses_unsafe_path_and_actor_before_network_or_mutation(self):
        stack = mock.Mock()
        api = c.LocalApi(config(), stack)
        with mock.patch.object(c.http.client, "HTTPConnection", side_effect=AssertionError("network forbidden")):
            for path in ("https://evil.invalid/auth/v1/admin/users", "/auth/v1/../admin/users", "/auth/v1/admin/users#fragment", "/rest/v1/contacts\r\nAuthorization: secret", "/auth//v1/admin/users"):
                with self.assertRaises(c.Refusal):
                    api.request(path, method="POST", body={})
            with self.assertRaises(c.Refusal):
                api.request("/rest/v1/contacts", actor="unknown")
        stack.verify.assert_not_called()


if __name__ == "__main__":
    unittest.main()
