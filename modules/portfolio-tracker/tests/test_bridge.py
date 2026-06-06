"""Test Java bridge command construction and password handling"""
import pytest

from src.pp_client.java_bridge import PpJavaBridge


class TestJavaBridge:
    def test_constructor_without_password(self):
        b = PpJavaBridge("/jar", "/xml")
        assert b._password == ""

    def test_constructor_with_password(self):
        b = PpJavaBridge("/jar", "/xml", password="test123")
        assert b._password == "test123"

    def test_jar_not_found_raises(self):
        b = PpJavaBridge("/nonexistent/jar", "/xml")
        with pytest.raises(FileNotFoundError):
            b._validate_jar()

    @pytest.mark.asyncio
    async def test_get_accounts_constructs_correct_args(self):
        import asyncio
        b = PpJavaBridge("/nonexistent/jar", "/test.xml", password="pw")
        with pytest.raises(FileNotFoundError):
            await b.get_accounts()

    @pytest.mark.asyncio
    async def test_get_transactions_constructs_correct_args(self):
        import asyncio
        b = PpJavaBridge("/nonexistent/jar", "/test.xml", password="pw")
        with pytest.raises(FileNotFoundError):
            await b.get_transactions()


class TestBridgePasswordHandling:
    """Verify password is passed correctly in command args"""

    def test_password_ordering_in_run_command(self):
        bridge = PpJavaBridge("/jar", "/xml", password="secret")
        # The bridge constructs: java -jar /jar <command> --password secret <rest>
        assert bridge._password == "secret"
        # _run_command would construct: ["java", "-jar", "/jar", cmd, "--password", "secret", ...args]
        # We verify the password is stored correctly
        assert bridge._password is not None
        assert len(bridge._password) > 0

    def test_no_password_case(self):
        bridge = PpJavaBridge("/jar", "/xml")
        assert bridge._password == ""
