# A Hermes agent plus its own usage client, in one image.
# No node, no agentsview — the whole point is that this runs where the agent
# runs, which is a container, not somebody's laptop.
FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ripgrep ca-certificates curl sqlite3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /usr/local/bin/uv

ARG HERMES_REF=v2026.8.19
RUN git clone --depth 1 --branch ${HERMES_REF} \
        https://github.com/NousResearch/hermes-agent /opt/hermes

WORKDIR /opt/hermes
RUN uv venv && uv pip install --no-cache-dir -e .
ENV PATH=/opt/hermes/.venv/bin:$PATH

# Hermes keeps state.db under HERMES_HOME; the client reads it from there.
ENV HERMES_HOME=/opt/data
RUN mkdir -p /opt/data

# The client this repo ships, under the name the agent's reporter service
# execs. It used to install hermes_client.py, which is the tokenmaxxing-format
# fork kept for lineage (see FORK.md): it wants TKMX_API_KEY and posts to
# tokenmaxxing, so a rebuild quietly shipped a reporter that cannot talk to the
# Agent Index at all.
COPY --chmod=0755 agent_index_client.py /usr/local/bin/agent-index-client

CMD ["bash"]
