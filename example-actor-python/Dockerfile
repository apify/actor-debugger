FROM apify/actor-python:3.13
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . ./
# One-line change enables the debugger (revert to the normal entrypoint to disable):
CMD ["python3", "-m", "actor_debugger", "--brk"]
