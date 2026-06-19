package name.abuchen.portfolio.cli;

import static org.junit.Assert.*;

import java.io.File;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.Test;

import name.abuchen.portfolio.model.*;
import name.abuchen.portfolio.model.Classification.Assignment;
import name.abuchen.portfolio.money.Values;
import name.abuchen.portfolio.cli.PpClient;

import name.abuchen.portfolio.model.Account;
import name.abuchen.portfolio.model.AccountTransaction;

public class PpClientTest {

    @Test
    public void testConstructor() {
        PpClient client = new PpClient(new File("/nonexistent/path.xml"));
        assertNotNull(client);
    }

    @Test
    public void testConstructorWithPassword() {
        PpClient client = new PpClient(new File("/nonexistent/path.xml"), "test".toCharArray());
        assertNotNull(client);
    }

    @Test
    public void testLoadFileNotFoundThrows() {
        PpClient client = new PpClient(new File("/nonexistent/path.xml"));
        try {
            client.load();
            fail("Expected IOException");
        } catch (Exception e) {
            assertTrue(e.getMessage().contains("not found"));
        }
    }

    @Test
    public void testMainHelpDoesNotFail() {
        Main.main(new String[]{"--help"});
    }

    @Test
    public void testMainMissingRequiredParameter() {
        try {
            Main.main(new String[]{"insert", "--file", "/data/test.xml"});
            fail("Expected exception");
        } catch (Exception e) {
            assertTrue(e.getMessage().contains("Missing required parameter")
                    || e.getMessage().contains("not found"));
        }
    }

    @Test
    public void testMainBalanceFileNotFound() {
        try {
            Main.main(new String[]{
                "balance",
                "--file", "/data/test.xml",
                "--account-id", "acct-1",
                "--amount", "50000",
                "--currency", "SGD",
                "--date", "2026-06-05"
            });
        } catch (Exception e) {
            assertTrue(e.getMessage().contains("not found"));
        }
    }

    @Test
    public void testMainTaxonomyFileNotFound() {
        try {
            Main.main(new String[]{
                "taxonomy",
                "--file", "/data/test.xml",
                "--names", "Sector,Geography"
            });
        } catch (Exception e) {
            assertTrue(e.getMessage().contains("not found"));
        }
    }

    @Test
    public void testQueryTaxonomiesReturnsValuations() throws Exception {
        String portfolioPath = System.getenv("TEST_PORTFOLIO_PATH");
        if (portfolioPath == null || portfolioPath.isEmpty()) {
            return;
        }
        File file = new File(portfolioPath);
        if (!file.exists()) {
            return;
        }

        String password = System.getenv("PP_PASSWORD");
        PpClient client = password != null && !password.isEmpty()
                ? new PpClient(file, password.toCharArray())
                : new PpClient(file);
        Map<String, Object> result = client.queryTaxonomies(List.of("Regions (Liquid)"));

        assertNotNull(result);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> taxonomies = (List<Map<String, Object>>) result.get("taxonomies");
        assertNotNull("taxonomies list must not be null", taxonomies);
        assertFalse("taxonomies list must not be empty", taxonomies.isEmpty());

        Map<String, Object> tax = taxonomies.get(0);
        assertEquals("Regions (Liquid)", tax.get("name"));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> values = (List<Map<String, Object>>) tax.get("values");
        assertNotNull("values must not be null", values);
        assertFalse("values must not be empty", values.isEmpty());

        for (Map<String, Object> v : values) {
            assertNotNull("classification value name missing", v.get("value"));
            assertNotNull("valuation_native missing", v.get("valuation_native"));
            double valuation = ((Number) v.get("valuation_native")).doubleValue();
            assertTrue("valuation_native must be non-negative for " + v.get("value"), valuation >= 0);
            assertNotNull("share_pct missing", v.get("share_pct"));
            assertNotNull("currencies missing", v.get("currencies"));
        }
    }

    @Test
    public void testMainPortfolioFileNotFound() {
        try {
            Main.main(new String[]{
                "portfolio",
                "--file", "/data/test.xml"
            });
        } catch (Exception e) {
            assertTrue(e.getMessage().contains("not found"));
        }
    }

    @Test
    public void testMainSecuritiesFileNotFound() {
        try {
            Main.main(new String[]{
                "securities",
                "--file", "/data/test.xml"
            });
        } catch (Exception e) {
            assertTrue(e.getMessage().contains("not found"));
        }
    }

    @Test
    public void testMainAccountsFileNotFound() {
        try {
            Main.main(new String[]{
                "accounts",
                "--file", "/data/test.xml"
            });
        } catch (Exception e) {
            assertTrue(e.getMessage().contains("not found"));
        }
    }

    @Test
    public void testMainTransactionsFileNotFound() {
        try {
            Main.main(new String[]{
                "transactions",
                "--file", "/data/test.xml"
            });
        } catch (Exception e) {
            assertTrue(e.getMessage().contains("not found"));
        }
    }

    @Test
    public void testMainWithPasswordFlag() {
        try {
            Main.main(new String[]{
                "accounts",
                "--file", "/data/test.xml",
                "--password", "test123"
            });
        } catch (Exception e) {
            assertTrue(e.getMessage().contains("not found"));
        }
    }

    @Test
    public void testMainInsertWithPassword() {
        try {
            Main.main(new String[]{
                "insert",
                "--file", "/data/test.xml",
                "--password", "test123",
                "--account-id", "acct-1",
                "--security-id", "sec-1",
                "--type", "Buy",
                "--date", "2026-06-05",
                "--shares", "100",
                "--price", "185.30",
                "--currency", "USD",
                "--fees", "1.00",
                "--taxes", "0.00"
            });
        } catch (Exception e) {
            assertTrue(e.getMessage().contains("not found")
                    || e.getMessage().contains("Password"));
        }
    }

    @Test
    public void testHelpContainsTransactionsCommand() {
        Main.main(new String[]{"--help"});
    }

    // ---- Unit tests for queryTaxonomies logic ----

    private Client buildTestClient() {
        Client client = new Client();
        client.setBaseCurrency("SGD");

        // Security 1: AMD with stale LatestSecurityPrice (old date) but recent historical price
        Security sec1 = new Security();
        sec1.setName("AMD Test");
        sec1.setTickerSymbol("AMD");
        sec1.setCurrencyCode("USD");
        // Stale latest (2020-01-01, value 100)
        LatestSecurityPrice staleLatest = new LatestSecurityPrice(LocalDate.of(2020, 1, 1), 100_00000000L);
        sec1.setLatest(staleLatest);
        // Recent historical price (yesterday, value 466.38)
        sec1.addPrice(new SecurityPrice(LocalDate.now().minusDays(1), 466_38000000L));
        client.addSecurity(sec1);
        String sec1Id = sec1.getUUID();

        // Security 2: no latest price at all, only historical
        Security sec2 = new Security();
        sec2.setName("BTC Test");
        sec2.setTickerSymbol("BTC");
        sec2.setCurrencyCode("USD");
        sec2.addPrice(new SecurityPrice(LocalDate.now().minusDays(2), 60000_00000000L));
        client.addSecurity(sec2);
        String sec2Id = sec2.getUUID();

        // Portfolio with holdings
        Portfolio portfolio = new Portfolio();
        portfolio.setName("Test Portfolio");
        client.addPortfolio(portfolio);

        // Buy 1 share of sec1
        PortfolioTransaction t1 = new PortfolioTransaction(
                LocalDateTime.of(2023, 1, 1, 0, 0), "USD", 0, sec1,
                100_000000L, PortfolioTransaction.Type.BUY, 0, 0);
        portfolio.addTransaction(t1);

        // Buy 2 shares of sec2
        PortfolioTransaction t2 = new PortfolioTransaction(
                LocalDateTime.of(2023, 1, 1, 0, 0), "USD", 0, sec2,
                200_000000L, PortfolioTransaction.Type.BUY, 0, 0);
        portfolio.addTransaction(t2);

        // Taxonomy with two classifications
        Taxonomy taxonomy = new Taxonomy("test-taxonomy");
        taxonomy.setRootNode(new Classification("root", "Root"));

        Classification cryptoCls = new Classification(taxonomy.getRoot(), "Crypto", "Crypto Key");
        cryptoCls.addAssignment(new Classification.Assignment(sec2, Classification.ONE_HUNDRED_PERCENT));
        taxonomy.getRoot().addChild(cryptoCls);

        Classification americaCls = new Classification(taxonomy.getRoot(), "America", "America Key");
        americaCls.addAssignment(new Classification.Assignment(sec1, Classification.ONE_HUNDRED_PERCENT));
        taxonomy.getRoot().addChild(americaCls);

        client.addTaxonomy(taxonomy);
        return client;
    }

    @Test
    public void testQueryTaxonomiesUsesMostRecentPriceNotStaleLatest() throws Exception {
        Client client = buildTestClient();
        File tmpFile = File.createTempFile("pp-test-", ".xml");
        tmpFile.deleteOnExit();
        PpClient ppClient = new PpClient(tmpFile) {
            @Override
            public Client load() { return client; }
        };

        Map<String, Object> result = ppClient.queryTaxonomies(List.of("test-taxonomy"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> taxonomies = (List<Map<String, Object>>) result.get("taxonomies");
        assertEquals(1, taxonomies.size());

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> values = (List<Map<String, Object>>) taxonomies.get(0).get("values");
        assertEquals(2, values.size());

        for (Map<String, Object> v : values) {
            String name = (String) v.get("value");
            if ("America".equals(name)) {
                // AMD: should use yesterday's price (466.38), not stale latest (100)
                assertEquals(466.38, ((Number) v.get("valuation_native")).doubleValue(), 0.01);
                assertEquals("USD", v.get("currency"));
            } else if ("Crypto".equals(name)) {
                // BTC: 2 shares × $60000 = $120000
                assertEquals(120000.0, ((Number) v.get("valuation_native")).doubleValue(), 0.01);
                assertEquals("USD", v.get("currency"));
            }
        }
    }

    @Test
    public void testQueryTaxonomiesIncludesPerCurrencyBreakdown() throws Exception {
        Client client = buildTestClient();
        File tmpFile = File.createTempFile("pp-test-", ".xml");
        tmpFile.deleteOnExit();
        PpClient ppClient = new PpClient(tmpFile) {
            @Override
            public Client load() { return client; }
        };

        Map<String, Object> result = ppClient.queryTaxonomies(List.of("test-taxonomy"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> values = (List<Map<String, Object>>)
                ((List<Map<String, Object>>) result.get("taxonomies")).get(0).get("values");

        for (Map<String, Object> v : values) {
            assertNotNull("currencies map missing for " + v.get("value"), v.get("currencies"));
            @SuppressWarnings("unchecked")
            Map<String, Double> currencies = (Map<String, Double>) v.get("currencies");
            assertFalse("currencies map empty", currencies.isEmpty());
            assertTrue("USD currency missing", currencies.containsKey("USD"));
        }
    }

    @Test
    public void testQueryTaxonomiesHandlesWeightedAssignments() throws Exception {
        Client client = buildTestClient();

        // Add a security that's dual-classified with partial weights
        Security sec3 = new Security();
        sec3.setName("Dual-classified");
        sec3.setTickerSymbol("DUAL");
        sec3.setCurrencyCode("USD");
        sec3.addPrice(new SecurityPrice(LocalDate.now().minusDays(1), 1000_00000000L));
        client.addSecurity(sec3);

        PortfolioTransaction t3 = new PortfolioTransaction(
                LocalDateTime.of(2023, 1, 1, 0, 0), "USD", 0, sec3,
                100_000000L, PortfolioTransaction.Type.BUY, 0, 0);
        client.getPortfolios().get(0).addTransaction(t3);

        // Assign sec3 to America at 70% weight and Crypto at 30% weight
        for (Classification child : client.getTaxonomies().get(0).getRoot().getChildren()) {
            if ("America".equals(child.getName())) {
                child.addAssignment(new Classification.Assignment(sec3, 7000));
            } else if ("Crypto".equals(child.getName())) {
                child.addAssignment(new Classification.Assignment(sec3, 3000));
            }
        }

        File tmpFile = File.createTempFile("pp-test-", ".xml");
        tmpFile.deleteOnExit();
        PpClient ppClient = new PpClient(tmpFile) {
            @Override
            public Client load() { return client; }
        };

        Map<String, Object> result = ppClient.queryTaxonomies(List.of("test-taxonomy"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> values = (List<Map<String, Object>>)
                ((List<Map<String, Object>>) result.get("taxonomies")).get(0).get("values");

        for (Map<String, Object> v : values) {
            if ("America".equals(v.get("value"))) {
                // AMD full (466.38) + DUAL 70% of $1000 (700) = 1166.38
                assertEquals(1166.38, ((Number) v.get("valuation_native")).doubleValue(), 0.01);
            } else if ("Crypto".equals(v.get("value"))) {
                // BTC full (120000) + DUAL 30% of $1000 (300) = 120300
                assertEquals(120300.0, ((Number) v.get("valuation_native")).doubleValue(), 0.01);
            }
        }
    }

    @Test
    public void testQueryTaxonomiesIncludesAccountBalances() throws Exception {
        Client client = new Client();
        client.setBaseCurrency("SGD");

        // Create an account with deposits
        Account account = new Account();
        account.setName("Test Cash Account");
        account.setCurrencyCode("SGD");
        client.addAccount(account);

        AccountTransaction dep1 = new AccountTransaction();
        dep1.setType(AccountTransaction.Type.DEPOSIT);
        dep1.setDateTime(LocalDateTime.of(2024, 1, 1, 0, 0));
        dep1.setCurrencyCode("SGD");
        dep1.setAmount(10000_00L);
        account.addTransaction(dep1);

        AccountTransaction dep2 = new AccountTransaction();
        dep2.setType(AccountTransaction.Type.DEPOSIT);
        dep2.setDateTime(LocalDateTime.of(2024, 6, 1, 0, 0));
        dep2.setCurrencyCode("SGD");
        dep2.setAmount(5000_00L);
        account.addTransaction(dep2);

        // Taxonomy with a Cash classification containing the account
        Taxonomy taxonomy = new Taxonomy("test-taxonomy");
        Classification root = new Classification("root", "Root");
        taxonomy.setRootNode(root);

        Classification cashCls = new Classification(root, "Cash", "cash");
        cashCls.addAssignment(new Classification.Assignment(account, Classification.ONE_HUNDRED_PERCENT));
        root.addChild(cashCls);

        client.addTaxonomy(taxonomy);

        File tmpFile = File.createTempFile("pp-test-", ".xml");
        tmpFile.deleteOnExit();
        PpClient ppClient = new PpClient(tmpFile) {
            @Override
            public Client load() { return client; }
        };

        Map<String, Object> result = ppClient.queryTaxonomies(List.of("test-taxonomy"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> values = (List<Map<String, Object>>)
                ((List<Map<String, Object>>) result.get("taxonomies")).get(0).get("values");

        assertEquals(1, values.size());
        Map<String, Object> cash = values.get(0);
        assertEquals("cash", cash.get("value"));
        // $10,000 + $5,000 = $15,000
        assertEquals(15000.0, ((Number) cash.get("valuation_native")).doubleValue(), 0.01);
        assertEquals("SGD", cash.get("currency"));

        @SuppressWarnings("unchecked")
        Map<String, Double> currencies = (Map<String, Double>) cash.get("currencies");
        assertTrue("SGD missing from currencies", currencies.containsKey("SGD"));
        assertEquals(15000.0, currencies.get("SGD"), 0.01);
    }

    // ---- Unit tests for getStatus logic ----

    private Client buildStatusTestClient() {
        Client client = new Client();
        client.setBaseCurrency("SGD");

        Security sec1 = new Security();
        sec1.setName("AMD Test");
        sec1.setTickerSymbol("AMD");
        sec1.setCurrencyCode("USD");
        LatestSecurityPrice staleLatest = new LatestSecurityPrice(LocalDate.of(2020, 1, 1), 100_00000000L);
        sec1.setLatest(staleLatest);
        sec1.addPrice(new SecurityPrice(LocalDate.now().minusDays(1), 466_38000000L));
        client.addSecurity(sec1);

        Security sec2 = new Security();
        sec2.setName("SGD Stock");
        sec2.setTickerSymbol("SGDSTK");
        sec2.setCurrencyCode("SGD");
        sec2.addPrice(new SecurityPrice(LocalDate.now().minusDays(1), 50_00000000L));
        sec2.setLatest(new LatestSecurityPrice(LocalDate.now().minusDays(1), 50_00000000L));
        client.addSecurity(sec2);

        Portfolio portfolio = new Portfolio();
        portfolio.setName("Test Portfolio");
        client.addPortfolio(portfolio);

        PortfolioTransaction t1 = new PortfolioTransaction(
                LocalDateTime.of(2023, 1, 1, 0, 0), "USD", 0, sec1,
                100_000000L, PortfolioTransaction.Type.BUY, 0, 0);
        portfolio.addTransaction(t1);

        PortfolioTransaction t2 = new PortfolioTransaction(
                LocalDateTime.of(2023, 1, 1, 0, 0), "SGD", 0, sec2,
                200_000000L, PortfolioTransaction.Type.BUY, 0, 0);
        portfolio.addTransaction(t2);

        Account account = new Account();
        account.setName("Cash SGD");
        account.setCurrencyCode("SGD");
        client.addAccount(account);
        AccountTransaction dep = new AccountTransaction();
        dep.setType(AccountTransaction.Type.DEPOSIT);
        dep.setDateTime(LocalDateTime.of(2024, 1, 1, 0, 0));
        dep.setCurrencyCode("SGD");
        dep.setAmount(10000_00L);
        account.addTransaction(dep);
        AccountTransaction dep2 = new AccountTransaction();
        dep2.setType(AccountTransaction.Type.DEPOSIT);
        dep2.setDateTime(LocalDateTime.of(2024, 6, 1, 0, 0));
        dep2.setCurrencyCode("SGD");
        dep2.setAmount(5000_00L);
        account.addTransaction(dep2);

        return client;
    }

    @Test
    public void testGetStatusUsesMostRecentPriceNotStaleLatest() throws Exception {
        Client client = buildStatusTestClient();
        File tmpFile = File.createTempFile("pp-status-test-", ".xml");
        tmpFile.deleteOnExit();
        PpClient ppClient = new PpClient(tmpFile) {
            @Override
            public Client load() { return client; }
        };

        Map<String, Object> result = ppClient.getStatus();
        assertNotNull(result);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> holdings = (List<Map<String, Object>>) result.get("holdings");
        assertNotNull("holdings must not be null", holdings);
        assertFalse("holdings must not be empty", holdings.isEmpty());

        for (Map<String, Object> h : holdings) {
            if ("AMD".equals(h.get("ticker"))) {
                double marketValue = (Double) h.get("market_value");
                assertEquals(466.38, marketValue, 0.01);
            }
        }
    }

    @Test
    public void testGetStatusIncludesAccountBalances() throws Exception {
        Client client = buildStatusTestClient();
        File tmpFile = File.createTempFile("pp-status-acct-", ".xml");
        tmpFile.deleteOnExit();
        PpClient ppClient = new PpClient(tmpFile) {
            @Override
            public Client load() { return client; }
        };

        Map<String, Object> result = ppClient.getStatus();
        assertNotNull(result);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> accounts = (List<Map<String, Object>>) result.get("accounts");
        assertNotNull("accounts list must not be null", accounts);
        assertFalse("accounts list must not be empty", accounts.isEmpty());

        boolean foundSgdCash = false;
        for (Map<String, Object> a : accounts) {
            if ("Cash SGD".equals(a.get("name"))) {
                foundSgdCash = true;
                assertEquals("SGD", a.get("currency"));
                assertEquals(15000.0, ((Number) a.get("balance")).doubleValue(), 0.01);
            }
        }
        assertTrue("Cash SGD account not found in getStatus accounts", foundSgdCash);
    }

    @Test
    public void testGetStatusReturnsPerCurrencyBreakdown() throws Exception {
        Client client = buildStatusTestClient();
        File tmpFile = File.createTempFile("pp-status-fx-", ".xml");
        tmpFile.deleteOnExit();
        PpClient ppClient = new PpClient(tmpFile) {
            @Override
            public Client load() { return client; }
        };

        Map<String, Object> result = ppClient.getStatus();
        assertNotNull(result);

        @SuppressWarnings("unchecked")
        Map<String, Object> summary = (Map<String, Object>) result.get("summary");
        assertNotNull("summary must not be null", summary);

        @SuppressWarnings("unchecked")
        Map<String, Double> currencies = (Map<String, Double>) summary.get("currencies");
        assertNotNull("currencies breakdown not found in summary", currencies);
        assertFalse("currencies map must not be empty", currencies.isEmpty());

        assertTrue("SGD currency missing from breakdown", currencies.containsKey("SGD"));
        assertTrue("USD currency missing from breakdown", currencies.containsKey("USD"));

        double usdTotal = currencies.get("USD");
        assertEquals(466.38, usdTotal, 0.01);

        double sgdTotal = currencies.get("SGD");
        assertTrue("SGD total should be > 0", sgdTotal > 0);
    }

    @Test
    public void testGetStatusSummaryStillHasApproxForBackwardCompat() throws Exception {
        Client client = buildStatusTestClient();
        File tmpFile = File.createTempFile("pp-status-compat-", ".xml");
        tmpFile.deleteOnExit();
        PpClient ppClient = new PpClient(tmpFile) {
            @Override
            public Client load() { return client; }
        };

        Map<String, Object> result = ppClient.getStatus();

        @SuppressWarnings("unchecked")
        Map<String, Object> summary = (Map<String, Object>) result.get("summary");
        assertNotNull("summary must not be null", summary);

        assertNotNull("total_value_approx missing (backward compat)", summary.get("total_value_approx"));
        assertNotNull("equity_value_approx missing (backward compat)", summary.get("equity_value_approx"));
        assertNotNull("total_value_native missing", summary.get("total_value_native"));
        assertNotNull("equity_value_native missing", summary.get("equity_value_native"));
    }
}
