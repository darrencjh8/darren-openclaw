import asyncio
import logging
from io import BytesIO

from telegram import Bot, Update
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from src.agent.orchestrator import AgentOrchestrator

logger = logging.getLogger(__name__)


class TelegramHandler:
    def __init__(self, token: str, chat_id: str, orchestrator: AgentOrchestrator):
        self._token = token
        self._chat_id = chat_id
        self._orchestrator = orchestrator
        self._bot = Bot(token=token)
        self._app: Application | None = None

    async def send_message(self, text: str):
        await self._bot.send_message(chat_id=self._chat_id, text=text, parse_mode=ParseMode.HTML)

    async def download_file(self, file_id: str) -> bytes:
        file = await self._bot.get_file(file_id)
        buf = BytesIO()
        await file.download_to_memory(buf)
        return buf.getvalue()

    async def start_polling(self):
        self._app = Application.builder().token(self._token).build()

        self._app.add_handler(CommandHandler("start", self._handle_start))
        self._app.add_handler(CommandHandler("help", self._handle_help))
        self._app.add_handler(CommandHandler("ibkr", self._handle_ibkr))
        self._app.add_handler(CommandHandler("sync", self._handle_sync))
        self._app.add_handler(CommandHandler("sheet", self._handle_sheet))
        self._app.add_handler(CommandHandler("status", self._handle_status))
        self._app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self._handle_text))
        self._app.add_handler(MessageHandler(filters.Document.PDF, self._handle_pdf))
        self._app.add_handler(MessageHandler(filters.Document.XML, self._handle_xml))
        self._app.add_handler(MessageHandler(filters.Document.ALL, self._handle_other_doc))
        self._app.add_handler(MessageHandler(filters.PHOTO, self._handle_photo))

        if self._app is not None:
            await self._app.initialize()
            await self._app.start()
            await self._app.updater.start_polling()
            logger.info("Telegram polling started")

    async def stop(self):
        if self._app is not None:
            await self._app.updater.stop()
            await self._app.stop()
            await self._app.shutdown()

    async def _authorize(self, update: Update) -> bool:
        if str(update.effective_chat.id) != self._chat_id:
            return False
        return True

    async def _handle_start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not await self._authorize(update):
            return
        await update.message.reply_text(
            "Portfolio Tracker agent ready. Send me:\n"
            "📄 PDF trade confirmations\n"
            "📊 IBKR flex query XML files\n"
            "/sync — Update PP balances from Actual Budget\n"
            "/sheet — Export taxonomy to Google Sheets\n"
            "/status — Portfolio snapshot\n"
            "/help — Show commands"
        )

    async def _handle_help(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not await self._authorize(update):
            return
        await update.message.reply_text(
            "/ibkr — Import IBKR flex query XML\n"
            "/sync — Update PP balances from Actual Budget\n"
            "/sheet — Export taxonomy to Google Sheets\n"
            "/status — Portfolio snapshot\n"
            "📄 Send a PDF to import a trade confirmation\n"
            "📊 Send an XML to import IBKR flex query"
        )

    async def _handle_ibkr(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not await self._authorize(update):
            return
        await update.message.reply_text("Send me your IBKR flex query XML file.")

    async def _handle_sync(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not await self._authorize(update):
            return
        await update.message.reply_text("Running balance sync...")
        result = await self._orchestrator.process_event(
            "balance_sync",
            "",
            correlation_id=f"sync-{update.update_id}",
            reply_callback=self.send_message,
        )

    async def _handle_sheet(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not await self._authorize(update):
            return
        await update.message.reply_text("Exporting taxonomies to Google Sheets...")
        result = await self._orchestrator.process_event(
            "taxonomy_export",
            "",
            correlation_id=f"sheet-{update.update_id}",
            reply_callback=self.send_message,
        )

    async def _handle_status(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not await self._authorize(update):
            return
        await update.message.reply_text("Status check — feature coming soon.")

    async def _handle_text(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not await self._authorize(update):
            return
        user_text = update.message.text
        response = self._orchestrator.handle_user_response(user_text)
        if response == "approved":
            await update.message.reply_text("Proceeding with the import...")
        elif response == "rejected":
            await update.message.reply_text("Cancelled. No transactions were imported.")
        else:
            await self._orchestrator.process_event(
                "text",
                user_text,
                correlation_id=f"msg-{update.update_id}",
                reply_callback=self.send_message,
            )

    async def _handle_pdf(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not await self._authorize(update):
            return
        doc = update.message.document
        await update.message.reply_text("Processing PDF receipt...")
        pdf_bytes = await self.download_file(doc.file_id)
        await self._orchestrator.process_event(
            "pdf_receipt",
            pdf_bytes,
            correlation_id=f"pdf-{doc.file_unique_id}",
            reply_callback=self.send_message,
        )

    async def _handle_xml(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not await self._authorize(update):
            return
        doc = update.message.document
        await update.message.reply_text("Processing IBKR flex query...")
        xml_bytes = await self.download_file(doc.file_id)
        xml_content = xml_bytes.decode("utf-8", errors="replace")
        await self._orchestrator.process_event(
            "ibkr_flex_query",
            xml_content,
            correlation_id=f"ibkr-{doc.file_unique_id}",
            reply_callback=self.send_message,
        )

    async def _handle_other_doc(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not await self._authorize(update):
            return
        await update.message.reply_text("Unsupported file type. Send PDF or XML files only.")

    async def _handle_photo(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not await self._authorize(update):
            return
        await update.message.reply_text("Photo received. For trade confirmations, please send the PDF instead for better OCR accuracy.")
