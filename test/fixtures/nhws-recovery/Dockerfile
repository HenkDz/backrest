FROM docker.io/garethgeorge/backrest@sha256:b852979754281026230cc69fb11428e6d57c9a97784ab4a444ffc7934c53a215
RUN apk add --no-cache python3 openssh-server && ln -s /bin/restic /usr/local/bin/restic
COPY scripts/nhws_staging_recovery.py /usr/local/libexec/nhweb-backups/staging_recovery.py
RUN chmod 755 /usr/local/libexec/nhweb-backups/staging_recovery.py && ssh-keygen -A
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["sleep infinity"]
