# Portfolio Tracker

LLM-powered agent that synchronizes investment data across Portfolio Performance, IBKR, Actual Budget, and Google Sheets.

## Architecture

```
Telegram / Email → Agent Orchestrator (DeepSeek LLM) → Java CLI → PP XML
                                     ↕
                          Actual Budget API / Google Sheets
```

## Prerequisites

- Python 3.12+
- Java 17+ JRE (for the PP CLI tool)
- Tesseract OCR + Poppler (for PDF processing)
- Portfolio Performance 0.84.1+ installed locally
- DeepSeek API key
- Telegram Bot token (via @BotFather)
- Google Cloud service account (for Sheets)

## Setup

### 1. Build the Java CLI

The Portfolio Performance model JAR is not on Maven Central — it must be built from source:

```bash
git clone https://github.com/portfolio-performance/portfolio
cd portfolio
mvn install -DskipTests
cd ../modules/portfolio-tracker
mvn clean package -f pp-cli/pom.xml
```

This produces `pp-cli/target/pp-cli.jar`.

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials:
#   DEEPSEEK_API_KEY, ACTUAL_BUDGET_URL/PASSWORD/FILE, MYR_BUDGET_FILE
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (optional)
#   GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SHEET_ID (optional)
#   PP_XML_PATH, PP_EMERGENCY_SGD_ACCOUNT, etc.
```

### 3. Install Python Dependencies

```bash
pip install -r requirements.txt
```

### 4. Run

```bash
python -m src.main
```

Or via Docker:

```bash
docker build -f docker/Dockerfile -t portfolio-tracker .
docker run -v $(pwd)/.env:/app/.env:ro \
           -v /path/to/portfolio.xml:/data/portfolio.xml \
           -v /path/to/google-service-account.json:/app/config/google-service-account.json \
           -p 8081:8081 \
           portfolio-tracker
```

## Telegram Commands

| Command | Action |
|---|---|
| `/ibkr` | Prompt to send IBKR flex query XML |
| `/sync` | Trigger Actual Budget → PP balance sync |
| `/sheet` | Trigger taxonomy → Google Sheets export |
| `/status` | Show recent activity |
| `/help` | Show commands |

Send PDF trade confirmations or IBKR XML files directly to the bot.

## How It Works

1. **Inbound events** arrive via Telegram (PDF/XML) or IMAP email
2. **LLM classifies** intent and extracts structured data via deterministic tools (OCR, XML parsing)
3. **Tools fetch live context** from PP (accounts, securities) and Actual Budget
4. **LLM matches** securities by ISIN/ticker, accounts by broker/currency
5. **Confirmation** is requested for multi-trade imports
6. **Java CLI** safely writes transactions to PP XML using PP's own model classes
7. **Memory** learns successful matches for future accuracy

## Testing

```bash
pytest tests/ -v          # 111 tests
mvn test -f pp-cli        # Java CLI tests (requires PP JAR installed)
```
