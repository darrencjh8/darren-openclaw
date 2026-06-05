package name.abuchen.portfolio.cli;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
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
import name.abuchen.portfolio.model.Portfolio;
import name.abuchen.portfolio.model.PortfolioTransaction;
import name.abuchen.portfolio.model.Security;
import name.abuchen.portfolio.model.Taxonomy;
import name.abuchen.portfolio.model.Transaction;
import name.abuchen.portfolio.money.Money;
import name.abuchen.portfolio.money.Values;

public class PpClient {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private final File clientFile;

    public PpClient(File clientFile) {
        this.clientFile = clientFile;
    }

    public Client load() throws IOException {
        if (!clientFile.exists()) {
            throw new IOException("PP file not found: " + clientFile.getAbsolutePath());
        }
        try (InputStream input = new FileInputStream(clientFile)) {
            return ClientFactory.load(input);
        }
    }

    public void save(Client client) throws IOException {
        ClientFactory.save(client, clientFile);
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
            entry.setMonetaryAmount(Money.of(currencyCode, Math.round(price * 100)));
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

        AccountTransaction at = new AccountTransaction();
        at.setType(AccountTransaction.Type.DEPOSIT);
        at.setDateTime(dateTime);
        at.setMonetaryAmount(Money.of(currencyCode, Math.round(amount * 100)));
        at.setCurrencyCode(currencyCode);
        if (notes != null && !notes.isEmpty()) {
            at.setNote(notes);
        }
        account.addTransaction(at);

        save(client);

        Map<String, Object> response = new HashMap<>();
        response.put("status", "updated");
        return response;
    }

    public Map<String, Object> queryTaxonomies(List<String> names) throws IOException {
        Client client = load();
        List<Map<String, Object>> taxonomies = new ArrayList<>();

        for (String name : names) {
            Taxonomy taxonomy = client.getTaxonomies().stream()
                    .filter(t -> name.equals(t.getId()) || name.equals(t.getName()))
                    .findFirst().orElse(null);
            if (taxonomy == null) continue;

            Map<String, List<Assignment>> groups = new HashMap<>();
            taxonomy.foreach(new Taxonomy.Visitor() {
                @Override
                public void visit(Classification classification, Assignment assignment) {
                    groups.computeIfAbsent(classification.getName(), k -> new ArrayList<>()).add(assignment);
                }
            });

            List<Map<String, Object>> values = new ArrayList<>();
            for (Map.Entry<String, List<Assignment>> entry : groups.entrySet()) {
                Map<String, Object> v = new HashMap<>();
                v.put("value", entry.getKey());
                v.put("count", entry.getValue().size());
                v.put("vehicles", entry.getValue().stream()
                        .map(a -> a.getInvestmentVehicle().getUUID()).toList());
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
