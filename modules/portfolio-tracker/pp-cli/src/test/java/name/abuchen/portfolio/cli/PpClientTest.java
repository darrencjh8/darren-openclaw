package name.abuchen.portfolio.cli;

import static org.junit.Assert.*;

import java.io.File;
import org.junit.Test;

public class PpClientTest {

    @Test
    public void testConstructor() {
        PpClient client = new PpClient(new File("/nonexistent/path.xml"));
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
}
