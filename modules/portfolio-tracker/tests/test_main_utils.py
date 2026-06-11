"""Test main.py startup utility functions"""
import pytest
from src.main import parse_cron


def test_parse_cron_valid():
    assert parse_cron("0 9 * * *") == {
        "minute": "0", "hour": "9", "day": "*", "month": "*", "day_of_week": "*"
    }


def test_parse_cron_multi_values():
    assert parse_cron("15,45 8-18 * * 1-5") == {
        "minute": "15,45", "hour": "8-18", "day": "*", "month": "*", "day_of_week": "1-5"
    }


def test_parse_cron_invalid():
    assert parse_cron("not valid") == {"minute": "0", "hour": "9"}


def test_parse_cron_empty():
    assert parse_cron("") == {"minute": "0", "hour": "9"}


def test_parse_cron_single_word():
    assert parse_cron("midnight") == {"minute": "0", "hour": "9"}
