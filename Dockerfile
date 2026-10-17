# The portal, as a container.
#
# Two things make this bigger than a Node image: Chromium, which turns the quotation
# template into a PDF, and curl, which carries e-mail to an SMTP server and XML to Tally.
# Both are deliberate — see server/pdf.js, server/mail.js and server/fetch.js for why each
# one is a process and not a library. Without them the portal still runs; it refuses those
# features by name, which is not what should be deployed.
#
#   docker build -t pie-erp .
#   docker run --rm -p 3000:3000 -e DATABASE_URL=... -v pie-files:/data/files pie-erp
#
# Node 22 because that is what this was built and tested on, pinned to a digest-free but
# specific minor so a rebuild six months from now is the same image.

FROM node:22.22-bookworm-slim

# Chromium, curl, and fonts.
#
# The fonts matter more than they look: a PDF is rendered by Chromium against whatever is
# installed, and a missing glyph is a box in a document that goes to a customer. The
# template asks for Verdana, which is not free and is not here, so it falls back — these
# three cover that fallback, and DejaVu carries the rupee sign (U+20B9), which Liberation
# alone does not reliably.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      curl \
      ca-certificates \
      fonts-liberation \
      fonts-dejavu-core \
      fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    ERP_CHROMIUM=/usr/bin/chromium \
    ERP_FILES_DIR=/data/files \
    PORT=3000

WORKDIR /app

# The dependency first, so a change to the portal's own code does not reinstall it.
# `npm ci` rather than `install`: it builds what the lockfile says and nothing else.
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server --omit=dev

# Only what the server reads at runtime. page.js assembles the portal from src/ and web/,
# so both are needed; tests, migrations and the export tooling are not.
COPY server/ ./server/
COPY src/ ./src/
COPY web/ ./web/
COPY assets/ ./assets/
# Not a migration script despite where it lives: db.js reads its column mapping from here,
# which it derives from src/Schema.gs so the database can never drift from the declaration
# the portal uses. The rest of migration/ is tooling and stays out.
COPY migration/schema.js ./migration/

# Where attachments go. The directory is created and given to the user the server runs as,
# but there is deliberately no VOLUME instruction: Railway refuses a Dockerfile containing
# one outright — "docker VOLUME at Line 60 is not supported, use Railway Volumes" — and
# every other host that matters here has its own way of attaching storage too. Declaring it
# bought nothing and cost a failed build.
#
# So the volume is attached by the host, mounted at /data/files. Without one, attachments
# are written into the container and vanish with it, which is why the deployment notes make
# it the first thing to set up and why /health reports whether the directory is writable.
RUN mkdir -p /data/files && chown -R node:node /data/files

# Not root. Chromium is given --no-sandbox because the content it renders is the portal's
# own template rather than anything from the internet, and the sandbox needs privileges
# this container deliberately does not have.
USER node

EXPOSE 3000

# No HEALTHCHECK instruction either. Every host this is going to has its own health check
# and will use it in preference; point it at /health, which answers in one request whether
# the database, the files directory, Chromium and the mailbox are all actually working.
# Docker's own runs as an exec inside the container, which is reported to misbehave on
# Railway, and a health check that fails spuriously restarts a working server for ever.

CMD ["node", "server/index.js"]
