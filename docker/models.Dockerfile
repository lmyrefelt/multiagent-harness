# CHANGE-0004 — local model runtime image
#
# Deliberately thin: the upstream Ollama image already ships the runtime, and
# this layer must NOT download models. Models are provisioned on the host by
# docker/fetch-models.sh and mounted read-only at /models (see compose.yaml).
#
# The tag is pinned on purpose: ollama/ollama#13039 recorded `latest` pointing at
# 0.12.4 while 0.12.10 was already released. Reproducibility here is a
# correctness control, not hygiene.
FROM ollama/ollama:0.12.11

# Serve only what has been provisioned for us. Never the default container path.
ENV OLLAMA_MODELS=/models

# Ollama still creates these at startup; with a read-only mount they must exist
# already (docker/fetch-models.sh creates them) or the server fails with
# "permission denied" and never becomes healthy.
RUN mkdir -p /models

EXPOSE 11434

# The upstream image sets ENTRYPOINT ["/bin/ollama"], so CMD supplies only the
# subcommand. Writing CMD ["ollama", "serve"] would invoke
# `/bin/ollama ollama serve` -> unknown command -> exit 1 -> crash loop.
CMD ["serve"]
