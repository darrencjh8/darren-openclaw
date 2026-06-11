package name.abuchen.portfolio.cli;

import java.io.File;
import java.io.IOException;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import name.abuchen.portfolio.model.Account;
import name.abuchen.portfolio.model.AccountTransaction;
import name.abuchen.portfolio.model.BuySellEntry;
import name.abuchen.portfolio.model.Classification;
import name.abuchen.portfolio.model.Classification.Assignment;
import name.abuchen.portfolio.model.Client;
import name.abuchen.portfolio.model.ClientFactory;
import name.abuchen.portfolio.model.HeadlessSave;
import name.abuchen.portfolio.model.InvestmentVehicle;
import name.abuchen.portfolio.model.LatestSecurityPrice;
import name.abuchen.portfolio.model.SecurityPrice;
import name.abuchen.portfolio.model.Portfolio;
import name.abuchen.portfolio.model.PortfolioTransaction;
import name.abuchen.portfolio.model.Security;
import name.abuchen.portfolio.model.Taxonomy;
import name.abuchen.portfolio.model.Transaction;
import name.abuchen.portfolio.money.CurrencyConverter;
import name.abuchen.portfolio.money.CurrencyConverterImpl;
import name.abuchen.portfolio.money.ExchangeRateProviderFactory;
import name.abuchen.portfolio.money.ExchangeRate;
import name.abuchen.portfolio.money.Money;
import name.abuchen.portfolio.money.Values;
import name.abuchen.portfolio.snapshot.AssetPosition;
import name.abuchen.portfolio.snapshot.ClientSnapshot;
import name.abuchen.portfolio.snapshot.filter.ClientClassificationFilter;
import org.eclipse.core.runtime.NullProgressMonitor;

public class PpClient {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private final File clientFile;
    private final char[] password;

    public PpClient(File clientFile) {
        this.clientFile = clientFile;
        this.password = null;
    }

    public PpClient(File clientFile, char[] password) {
        this.clientFile = clientFile;
        this.password = password;
    }

    public Client load() throws IOException {
        if (!clientFile.exists()) {
            throw new IOException("PP file not found: " + clientFile.getAbsolutePath());
        }
        // Try up to 3 times with recovery
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                return ClientFactory.load(clientFile, password, new NullProgressMonitor());
            } catch (Exception e) {
                if (attempt < 2 && (e.getMessage() != null && (
                        e.getMessage().contains("Protocol message") ||
                        e.getMessage().contains("IllegalBlockSize") ||
                        e.getMessage().contains("decrypt")))) {
                    System.err.println("PP file corrupted, attempting recovery (attempt " + (attempt + 1) + ")...");
                    // Trigger external recovery
                    try {
                        ProcessBuilder pb = new ProcessBuilder("python3", "/app/src/onedrive_download.py");
                        pb.inheritIO();
                        Process p = pb.start();
                        p.waitFor();
                    } catch (Exception ignored) {}
                } else {
                    throw new IOException("Failed to load PP file: " + e.getMessage(), e);
                }
            }
        }
        throw new IOException("Failed to load PP file after 3 recovery attempts");
    }

    public void save(Client client) throws IOException {
        HeadlessSave.save(client, clientFile, password);
    }

    public List<Map<String, Object>> listAccounts() throws IOException {
        Client client = load();
        List<Map<String, Object>> result = new ArrayList<>();
        for (Account account : client.getAccounts()) {
            Map<String, Object> acct = new HashMap<>();
            acct.put("id", account.getUUID());
            acct.put("name", account.getName());
            acct.put("currency", account.getCurrencyCode());
            result.add(acct);
        }
        for (Portfolio portfolio : client.getPortfolios()) {
            Map<String, Object> port = new HashMap<>();
            port.put("id", portfolio.getUUID());
            port.put("name", portfolio.getName());
            port.put("currency", portfolio.getReferenceAccount() != null
                    ? portfolio.getReferenceAccount().getCurrencyCode() : "");
            port.put("type", "PORTFOLIO");
            result.add(port);
        }
        return result;
    }

    public List<Map<String, Object>> listSecurities() throws IOException {
        Client client = load();
        List<Map<String, Object>> result = new ArrayList<>();
        for (Security security : client.getSecurities()) {
            Map<String, Object> sec = new HashMap<>();
            sec.put("id", security.getUUID());
            sec.put("name", security.getName());
            sec.put("isin", security.getIsin());
            sec.put("ticker", security.getTickerSymbol());
            sec.put("currency", security.getCurrencyCode());
            result.add(sec);
        }
        return result;
    }

    public Map<String, Object> insertTransaction(String accountId, String securityId, String type,
            String dateStr, long shares, double price, String currencyCode,
            double fees, double taxes, String notes) throws IOException {

        Client client = load();
        LocalDateTime dateTime = LocalDate.parse(dateStr).atStartOfDay();
        Account account = findAccount(client, accountId);
        Security security = securityId != null && !securityId.isEmpty()
                ? findSecurity(client, securityId) : null;

        String transactionId;

        if ("Buy".equals(type) || "Sell".equals(type)) {
            if (security == null) throw new IOException("Security required for " + type);

            BuySellEntry entry = new BuySellEntry();
            entry.setType("Buy".equals(type)
                    ? PortfolioTransaction.Type.BUY
                    : PortfolioTransaction.Type.SELL);
            entry.setDate(dateTime);
            entry.setSecurity(security);
            entry.setShares(Values.Share.factorize(shares));
            entry.setMonetaryAmount(Money.of(currencyCode, Math.round(price * Math.abs(shares) * 100)));
            entry.setAccount(account);
            if (!client.getPortfolios().isEmpty()) {
                entry.setPortfolio(client.getPortfolios().get(0));
            }
            if (notes != null && !notes.isEmpty()) {
                entry.setNote(notes);
            }
            if (fees > 0) {
                entry.getPortfolioTransaction()
                        .addUnit(new Transaction.Unit(Transaction.Unit.Type.FEE,
                                Money.of(currencyCode, Math.round(fees * 100))));
            }
            if (taxes > 0) {
                entry.getPortfolioTransaction()
                        .addUnit(new Transaction.Unit(Transaction.Unit.Type.TAX,
                                Money.of(currencyCode, Math.round(taxes * 100))));
            }
            entry.insert();
            transactionId = entry.getPortfolioTransaction().getUUID();

        } else if ("Dividend".equals(type)) {
            if (security == null) throw new IOException("Security required for Dividend");
            AccountTransaction at = new AccountTransaction();
            at.setType(AccountTransaction.Type.DIVIDENDS);
            at.setDateTime(dateTime);
            at.setSecurity(security);
            at.setMonetaryAmount(Money.of(currencyCode, Math.round(price * 100)));
            at.setCurrencyCode(currencyCode);
            if (notes != null && !notes.isEmpty()) at.setNote(notes);
            if (fees > 0) at.addUnit(new Transaction.Unit(Transaction.Unit.Type.FEE,
                    Money.of(currencyCode, Math.round(fees * 100))));
            if (taxes > 0) at.addUnit(new Transaction.Unit(Transaction.Unit.Type.TAX,
                    Money.of(currencyCode, Math.round(taxes * 100))));
            account.addTransaction(at);
            transactionId = at.getUUID();

        } else if ("Deposit".equals(type)) {
            AccountTransaction at = new AccountTransaction();
            at.setType(AccountTransaction.Type.DEPOSIT);
            at.setDateTime(dateTime);
            at.setMonetaryAmount(Money.of(currencyCode, Math.round(price * 100)));
            at.setCurrencyCode(currencyCode);
            if (notes != null && !notes.isEmpty()) at.setNote(notes);
            account.addTransaction(at);
            transactionId = at.getUUID();

        } else if ("Withdrawal".equals(type)) {
            AccountTransaction at = new AccountTransaction();
            at.setType(AccountTransaction.Type.REMOVAL);
            at.setDateTime(dateTime);
            at.setMonetaryAmount(Money.of(currencyCode, Math.round(price * 100)));
            at.setCurrencyCode(currencyCode);
            if (notes != null && !notes.isEmpty()) at.setNote(notes);
            account.addTransaction(at);
            transactionId = at.getUUID();

        } else if ("Fee".equals(type)) {
            AccountTransaction at = new AccountTransaction();
            at.setType(AccountTransaction.Type.FEES);
            at.setDateTime(dateTime);
            at.setMonetaryAmount(Money.of(currencyCode, Math.round(fees * 100)));
            at.setCurrencyCode(currencyCode);
            if (notes != null && !notes.isEmpty()) at.setNote(notes);
            account.addTransaction(at);
            transactionId = at.getUUID();

        } else if ("Tax".equals(type)) {
            AccountTransaction at = new AccountTransaction();
            at.setType(AccountTransaction.Type.TAXES);
            at.setDateTime(dateTime);
            at.setMonetaryAmount(Money.of(currencyCode, Math.round(taxes * 100)));
            at.setCurrencyCode(currencyCode);
            if (notes != null && !notes.isEmpty()) at.setNote(notes);
            account.addTransaction(at);
            transactionId = at.getUUID();

        } else if ("Interest".equals(type)) {
            AccountTransaction at = new AccountTransaction();
            at.setType(AccountTransaction.Type.INTEREST);
            at.setDateTime(dateTime);
            at.setMonetaryAmount(Money.of(currencyCode, Math.round(price * 100)));
            at.setCurrencyCode(currencyCode);
            if (notes != null && !notes.isEmpty()) at.setNote(notes);
            account.addTransaction(at);
            transactionId = at.getUUID();

        } else {
            throw new IOException("Unknown transaction type: " + type);
        }

        save(client);

        Map<String, Object> response = new HashMap<>();
        response.put("transaction_id", transactionId);
        response.put("status", "inserted");
        return response;
    }

    public Map<String, Object> updateBalance(String accountId, double amount,
            String currencyCode, String dateStr, String notes) throws IOException {

        Client client = load();
        LocalDateTime dateTime = LocalDate.parse(dateStr).atStartOfDay();
        Account account = findAccount(client, accountId);

        // Match PP official UI AccountSnapshot.create() formula:
        // iterate account transactions only, use isDebit() for sign
        long currentBalance = 0;
        for (AccountTransaction t : account.getTransactions()) {
            long amt = t.getMonetaryAmount().getAmount();
            if (t.getType().isDebit())
                currentBalance -= amt;
            else
                currentBalance += amt;
        }

        long targetCents = Math.round(amount * 100);
        long delta = targetCents - currentBalance;
        Map<String, Object> response = new HashMap<>();

        if (delta == 0) {
            response.put("status", "unchanged");
            response.put("current_balance", currentBalance / 100.0);
            response.put("target_amount", amount);
            response.put("delta", 0);
            return response;
        }

        AccountTransaction at = new AccountTransaction();
        at.setType(delta > 0 ? AccountTransaction.Type.DEPOSIT : AccountTransaction.Type.REMOVAL);
        at.setDateTime(dateTime);
        at.setMonetaryAmount(Money.of(currencyCode, Math.abs(delta)));
        at.setCurrencyCode(currencyCode);
        String fullNotes = (notes != null && !notes.isEmpty() ? notes + " | " : "")
                + "Delta: " + (delta > 0 ? "+" : "") + String.format("%.2f", delta / 100.0)
                + " (target S" + String.format("%.2f", amount) + ", was S" + String.format("%.2f", currentBalance / 100.0) + ")";
        at.setNote(fullNotes);
        account.addTransaction(at);

        save(client);

        response.put("status", "updated");
        response.put("transaction_id", at.getUUID());
        response.put("current_balance", currentBalance / 100.0);
        response.put("target_amount", amount);
        response.put("delta", delta / 100.0);
        return response;
    }

    public Map<String, Object> queryTaxonomies(List<String> names) throws IOException {
        Client client = load();

        // Build a map of security -> holdings info (shares, latest price, currency)
        Map<String, Map<String, Object>> securityHoldings = new HashMap<>();
        for (Security sec : client.getSecurities()) {
            long shares = 0;
            for (Portfolio portfolio : client.getPortfolios()) {
                for (PortfolioTransaction t : portfolio.getTransactions()) {
                    if (sec.equals(t.getSecurity())) {
                        switch (t.getType()) {
                            case BUY: case TRANSFER_IN: case DELIVERY_INBOUND:
                                shares += t.getShares(); break;
                            case SELL: case TRANSFER_OUT: case DELIVERY_OUTBOUND:
                                shares -= t.getShares(); break;
                            default: break;
                        }
                    }
                }
            }
            if (shares == 0) continue;

            // Always use the most recent price ≤ today from the full price history.
            // Never trust getLatest() directly — it can be years stale (stored separately).
            LatestSecurityPrice latest = null;
            LocalDate today = LocalDate.now();
            List<SecurityPrice> prices = sec.getPricesIncludingLatest();
            if (!prices.isEmpty()) {
                for (int i = prices.size() - 1; i >= 0; i--) {
                    SecurityPrice p = prices.get(i);
                    if (!p.getDate().isAfter(today)) {
                        if (p instanceof LatestSecurityPrice) {
                            latest = (LatestSecurityPrice) p;
                        } else {
                            latest = new LatestSecurityPrice(p.getDate(), p.getValue());
                        }
                        break;
                    }
                }
            }
            if (latest == null) continue;

            double price = latest.getValue() / Values.Quote.divider();
            double shareCount = Math.abs(shares) / Values.Share.divider();
            double marketValueNative = price * shareCount;

            Map<String, Object> h = new HashMap<>();
            h.put("currency", sec.getCurrencyCode());
            h.put("market_value_native", marketValueNative);
            h.put("name", sec.getName());
            h.put("ticker", sec.getTickerSymbol());
            h.put("shares_held", shares);
            h.put("latest_price_raw", latest.getValue());
            securityHoldings.put(sec.getUUID(), h);

        } // close for (Security sec : client.getSecurities())

        // Also build account balances for cash-equivalent accounts
        Map<String, Map<String, Object>> accountBalances = new HashMap<>();
        LocalDateTime now = LocalDateTime.now();
        for (Account account : client.getAccounts()) {
            long balance = account.getCurrentAmount(now);
            if (balance == 0) continue;
            Map<String, Object> h = new HashMap<>();
            h.put("currency", account.getCurrencyCode());
            h.put("market_value_native", balance / Values.Amount.divider());
            accountBalances.put(account.getUUID(), h);
        }

        List<Map<String, Object>> taxonomies = new ArrayList<>();
        for (String name : names) {
            Taxonomy taxonomy = client.getTaxonomies().stream()
                    .filter(t -> name.equals(t.getId()) || name.equals(t.getName()))
                    .findFirst().orElse(null);
            if (taxonomy == null) continue;

            // We report direct children of root. For "Invested" (which has children),
            // we report its children instead (America, Developed ex-US, Emerging, Crypto).
            Map<String, Map<String, Object>> aggregated = new LinkedHashMap<>();
            Classification root = taxonomy.getRoot();
            for (Classification level1 : root.getChildren()) {
                if (level1.getChildren().isEmpty()) {
                    // Leaf at root level (e.g., Investable Cash)
                    aggregateAssignmentsFlat(level1, level1.getName(), securityHoldings, accountBalances, aggregated);
                } else {
                    // Has children — report at child level (e.g., America, etc.)
                    for (Classification level2 : level1.getChildren()) {
                        aggregateAssignmentsFlat(level2, level2.getName(), securityHoldings, accountBalances, aggregated);
                    }
                }
            }

            double grandNative = 0;
            for (Map<String, Object> agg : aggregated.values()) {
                grandNative += (Double) agg.get("total_native");
            }

            List<Map<String, Object>> values = new ArrayList<>();
            for (Map.Entry<String, Map<String, Object>> entry : aggregated.entrySet()) {
                Map<String, Object> agg = entry.getValue();
                double nativeTotal = (Double) agg.get("total_native");
                Map<String, Object> v = new HashMap<>();
                v.put("value", entry.getKey());
                v.put("valuation_native", Math.round(nativeTotal * 100.0) / 100.0);
                v.put("currency", agg.get("currency"));
                v.put("count", agg.get("count"));
                v.put("currencies", agg.get("currencies"));  // per-currency native breakdown
                v.put("share_pct", grandNative > 0
                        ? Math.round(nativeTotal / grandNative * 10000.0) / 100.0 : 0.0);
                values.add(v);
            }

            Map<String, Object> tax = new HashMap<>();
            tax.put("name", name);
            tax.put("values", values);
            taxonomies.add(tax);
        }

        Map<String, Object> response = new HashMap<>();
        response.put("taxonomies", taxonomies);
        return response;
    }

    private void dumpTree(Classification cls, int depth) {
        String indent = "  ".repeat(depth);
        System.err.printf("%s[%s] %d assignments, %d children\n",
                indent, cls.getName(),
                cls.getAssignments().size(), cls.getChildren().size());
        for (Classification child : cls.getChildren()) {
            dumpTree(child, depth + 1);
        }
    }

    private void aggregateAssignmentsFlat(Classification cls, String groupName,
            Map<String, Map<String, Object>> securityHoldings,
            Map<String, Map<String, Object>> accountBalances,
            Map<String, Map<String, Object>> aggregated) {
        for (Assignment assignment : cls.getAssignments()) {
            addAssignmentToAggregate(assignment, groupName, securityHoldings, accountBalances, aggregated);
        }
        for (Classification child : cls.getChildren()) {
            aggregateAssignmentsFlat(child, groupName, securityHoldings, accountBalances, aggregated);
        }
    }

    private void addAssignmentToAggregate(Assignment assignment, String groupName,
            Map<String, Map<String, Object>> securityHoldings,
            Map<String, Map<String, Object>> accountBalances,
            Map<String, Map<String, Object>> aggregated) {
        String vehicleId = assignment.getInvestmentVehicle().getUUID();
        Map<String, Object> holding = securityHoldings.get(vehicleId);
        if (holding == null) {
            holding = accountBalances.get(vehicleId);
        }
        if (holding == null) return;
        String currency = (String) holding.get("currency");
        double nativeValue = (Double) holding.get("market_value_native");
        double weight = assignment.getWeight() / (double) Classification.ONE_HUNDRED_PERCENT;
        double prorated = nativeValue * weight;

        aggregated.computeIfAbsent(groupName, k -> {
            Map<String, Object> agg = new HashMap<>();
            agg.put("count", 0);
            agg.put("total_native", 0.0);
            agg.put("currencies", new LinkedHashMap<String, Double>());
            return agg;
        });
        Map<String, Object> agg = aggregated.get(groupName);
        agg.put("count", (Integer) agg.get("count") + 1);
        agg.put("total_native", (Double) agg.get("total_native") + prorated);
        @SuppressWarnings("unchecked")
        Map<String, Double> currencies = (Map<String, Double>) agg.get("currencies");
        currencies.merge(currency, prorated, Double::sum);
        agg.put("currency", currency);  // primary currency (may be overwritten)
    }

    public Map<String, Object> dumpPortfolio() throws IOException {
        Client client = load();
        Map<String, Object> response = new HashMap<>();
        response.put("accounts", listAccounts());
        response.put("securities", listSecurities());

        List<Map<String, Object>> holdings = new ArrayList<>();
        for (Portfolio portfolio : client.getPortfolios()) {
            Map<String, Object> holding = new HashMap<>();
            holding.put("portfolio_id", portfolio.getUUID());
            holding.put("portfolio_name", portfolio.getName());
            holding.put("reference_account", portfolio.getReferenceAccount() != null
                    ? portfolio.getReferenceAccount().getUUID() : "");
            holdings.add(holding);
        }
        response.put("holdings", holdings);
        return response;
    }

    public Map<String, Object> getStatus() throws IOException {
        Client client = load();
        Map<String, Object> result = new HashMap<>();

        List<Map<String, Object>> holdings = new ArrayList<>();
        double totalValue = 0;
        double equityValue = 0;
        Map<String, Double> currencyTotals = new LinkedHashMap<>();
        Map<String, Double> equityCurrencies = new LinkedHashMap<>();

        for (Security security : client.getSecurities()) {
            Map<String, Object> h = new HashMap<>();
            h.put("security_id", security.getUUID());
            h.put("ticker", security.getTickerSymbol());
            h.put("name", security.getName());
            h.put("currency", security.getCurrencyCode());

            long shares = 0;
            for (Portfolio portfolio : client.getPortfolios()) {
                for (PortfolioTransaction t : portfolio.getTransactions()) {
                    if (security.equals(t.getSecurity())) {
                        switch (t.getType()) {
                            case BUY:
                            case TRANSFER_IN:
                            case DELIVERY_INBOUND:
                                shares += t.getShares();
                                break;
                            case SELL:
                            case TRANSFER_OUT:
                            case DELIVERY_OUTBOUND:
                                shares -= t.getShares();
                                break;
                            default:
                                break;
                        }
                    }
                }
            }
            if (shares == 0) continue;

            LatestSecurityPrice latest = null;
            LocalDate today = LocalDate.now();
            List<SecurityPrice> prices = security.getPricesIncludingLatest();
            if (!prices.isEmpty()) {
                for (int i = prices.size() - 1; i >= 0; i--) {
                    SecurityPrice p = prices.get(i);
                    if (!p.getDate().isAfter(today)) {
                        if (p instanceof LatestSecurityPrice) {
                            latest = (LatestSecurityPrice) p;
                        } else {
                            latest = new LatestSecurityPrice(p.getDate(), p.getValue());
                        }
                        break;
                    }
                }
            }
            if (latest == null) continue;

            long quote = latest.getValue();
            long absShares = Math.abs(shares);
            double price = quote / Values.Quote.divider();
            double shareCount = absShares / Values.Share.divider();
            double marketValue = price * shareCount;
            h.put("latest_price", price);
            h.put("shares_display", shareCount);
            h.put("market_value", marketValue);

            totalValue += marketValue;
            equityValue += marketValue;
            String cc = security.getCurrencyCode();
            currencyTotals.merge(cc, marketValue, Double::sum);
            equityCurrencies.merge(cc, marketValue, Double::sum);

            holdings.add(h);
        }

        result.put("holdings", holdings);
        result.put("securities_with_holdings", holdings.size());
        result.put("total_securities", client.getSecurities().size());

        List<Map<String, Object>> accounts = new ArrayList<>();
        LocalDateTime now = LocalDateTime.now();
        for (Account account : client.getAccounts()) {
            long balance = account.getCurrentAmount(now);
            Map<String, Object> a = new HashMap<>();
            a.put("account_id", account.getUUID());
            a.put("name", account.getName());
            a.put("currency", account.getCurrencyCode());
            a.put("balance", balance / Values.Amount.divider());
            accounts.add(a);

            if (balance != 0) {
                double balDollars = balance / Values.Amount.divider();
                totalValue += balDollars;
                String cc = account.getCurrencyCode();
                currencyTotals.merge(cc, balDollars, Double::sum);
            }
        }
        result.put("accounts", accounts);

        Map<String, Object> summary = new HashMap<>();
        summary.put("total_value_approx", String.format("%.2f", totalValue));
        summary.put("equity_value_approx", String.format("%.2f", equityValue));
        summary.put("total_value_native", String.format("%.2f", totalValue));
        summary.put("equity_value_native", String.format("%.2f", equityValue));
        summary.put("currencies", currencyTotals);
        summary.put("equity_currencies", equityCurrencies);
        result.put("summary", summary);

        return result;
    }

    public Map<String, Object> querySecurity(String query) throws IOException {
        Client client = load();
        String q = query.toLowerCase().trim();

        Security found = null;
        for (Security s : client.getSecurities()) {
            if (s.getUUID().equals(query)
                    || (s.getTickerSymbol() != null && s.getTickerSymbol().toLowerCase().equals(q))
                    || (s.getIsin() != null && s.getIsin().equalsIgnoreCase(query))
                    || s.getName().toLowerCase().contains(q)) {
                found = s;
                break;
            }
        }

        if (found == null) {
            Map<String, Object> err = new HashMap<>();
            err.put("error", "Security not found: " + query);
            return err;
        }

        Map<String, Object> result = new HashMap<>();
        result.put("security_id", found.getUUID());
        result.put("ticker", found.getTickerSymbol());
        result.put("name", found.getName());
        result.put("isin", found.getIsin());
        result.put("currency", found.getCurrencyCode());

        long shares = 0;
        for (Portfolio portfolio : client.getPortfolios()) {
            for (PortfolioTransaction t : portfolio.getTransactions()) {
                if (found.equals(t.getSecurity())) {
                    switch (t.getType()) {
                        case BUY:
                        case TRANSFER_IN:
                        case DELIVERY_INBOUND:
                            shares += t.getShares();
                            break;
                        case SELL:
                        case TRANSFER_OUT:
                        case DELIVERY_OUTBOUND:
                            shares -= t.getShares();
                            break;
                        default:
                            break;
                    }
                }
            }
        }

        result.put("shares_held", shares);
        result.put("shares_held_display", Math.abs(shares) / Values.Share.divider());

        LatestSecurityPrice latest = null;
        LocalDate today = LocalDate.now();
        List<SecurityPrice> prices = found.getPricesIncludingLatest();
        if (!prices.isEmpty()) {
            for (int i = prices.size() - 1; i >= 0; i--) {
                SecurityPrice p = prices.get(i);
                if (!p.getDate().isAfter(today)) {
                    if (p instanceof LatestSecurityPrice) {
                        latest = (LatestSecurityPrice) p;
                    } else {
                        latest = new LatestSecurityPrice(p.getDate(), p.getValue());
                    }
                    break;
                }
            }
        }
        if (latest != null) {
            long quote = latest.getValue();
            double price = quote / Values.Quote.divider();
            double shareCount = Math.abs(shares) / Values.Share.divider();
            double marketValue = price * shareCount;
            result.put("latest_price", String.format("%.2f", price));
            result.put("market_value", String.format("%.2f", marketValue));
            result.put("shares_held_display", shareCount);
        }

        return result;
    }

    public List<Map<String, Object>> dumpTransactions() throws IOException {
        Client client = load();
        List<Map<String, Object>> result = new ArrayList<>();

        for (Account account : client.getAccounts()) {
            for (AccountTransaction t : account.getTransactions()) {
                Map<String, Object> tx = new HashMap<>();
                tx.put("date", t.getDateTime().toLocalDate().toString());
                tx.put("amount", t.getMonetaryAmount().getAmount());
                tx.put("amount_cents", (int) t.getMonetaryAmount().getAmount());
                tx.put("currency", t.getCurrencyCode());
                tx.put("account_id", account.getUUID());
                tx.put("type", t.getType().name());
                tx.put("uuid", t.getUUID());
                if (t.getSecurity() != null) {
                    tx.put("security_id", t.getSecurity().getUUID());
                }
                tx.put("notes", t.getNote() != null ? t.getNote() : "");
                result.add(tx);
            }
        }

        for (Portfolio portfolio : client.getPortfolios()) {
            for (PortfolioTransaction t : portfolio.getTransactions()) {
                Map<String, Object> tx = new HashMap<>();
                tx.put("date", t.getDateTime().toLocalDate().toString());
                tx.put("amount", t.getMonetaryAmount().getAmount());
                tx.put("amount_cents", (int) t.getMonetaryAmount().getAmount());
                tx.put("currency", t.getCurrencyCode());
                tx.put("account_id", portfolio.getReferenceAccount() != null
                        ? portfolio.getReferenceAccount().getUUID() : "");
                tx.put("type", t.getType().name());
                tx.put("uuid", t.getUUID());
                if (t.getSecurity() != null) {
                    tx.put("security_id", t.getSecurity().getUUID());
                }
                tx.put("notes", t.getNote() != null ? t.getNote() : "");
                result.add(tx);
            }
        }

        return result;
    }

    private Account findAccount(Client client, String accountId) throws IOException {
        for (Account a : client.getAccounts()) {
            if (a.getUUID().equals(accountId)) return a;
        }
        throw new IOException("Account not found: " + accountId);
    }

    private Security findSecurity(Client client, String securityId) throws IOException {
        for (Security s : client.getSecurities()) {
            if (s.getUUID().equals(securityId)) return s;
        }
        throw new IOException("Security not found: " + securityId);
    }
}
