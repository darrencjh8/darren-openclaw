package name.abuchen.portfolio.model;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.channels.FileChannel;
import java.util.Set;

/**
 * Provides save functionality without requiring the Eclipse OSGi runtime.
 * Uses ClientFactory's internal ClientPersister pipeline via reflection.
 */
public class HeadlessSave {

    public static void save(Client client, File file, char[] password) throws IOException {
        Set<SaveFlag> flags = client.getSaveFlags();
        if (flags.isEmpty())
            flags.add(SaveFlag.XML);

        if (flags.contains(SaveFlag.ENCRYPTED) && password == null && client.getSecret() == null)
            throw new IOException("Password is missing");

        try (FileOutputStream fos = new FileOutputStream(file);
             BufferedOutputStream bos = new BufferedOutputStream(fos, 65536)) {

            FileChannel channel = fos.getChannel();
            try {
                channel.tryLock();
            } catch (IOException ignored) {
            }

            Method buildPersister = ClientFactory.class.getDeclaredMethod(
                "buildPersister", Set.class, char[].class);
            buildPersister.setAccessible(true);
            Object persister = buildPersister.invoke(null, flags, password);

            Method saveMethod = persister.getClass().getMethod("save", Client.class, java.io.OutputStream.class);
            saveMethod.invoke(persister, client, bos);
            bos.flush();

            client.getSaveFlags().clear();
            client.getSaveFlags().addAll(flags);
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("Save failed: " + e.getMessage(), e);
        }
    }
}
