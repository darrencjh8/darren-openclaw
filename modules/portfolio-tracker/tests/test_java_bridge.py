import pytest

from src.pp_client.java_bridge import PpJavaBridge


def test_bridge_constructor():
    bridge = PpJavaBridge("/fake/path.jar", "/fake/data.xml")
    assert bridge is not None


def test_jar_not_found_raises():
    bridge = PpJavaBridge("/nonexistent/path.jar", "/fake/data.xml")
    with pytest.raises(FileNotFoundError):
        bridge._validate_jar()
