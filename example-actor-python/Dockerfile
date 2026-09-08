FROM apify/actor-python:3.13

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copies the Actor source AND the vendored actor_debugger/ package (self-contained demo -
# once the package is on PyPI this becomes `pip install actor-debugger` instead).
COPY . ./

# The one-line debug switch. `--brk` pauses on the first line until you attach from the
# browser; drop it to let the Actor run and attach mid-flight instead.
# To disable debugging, revert to: CMD ["python3", "-m", "src"]
CMD ["python3", "-m", "actor_debugger", "--brk"]
