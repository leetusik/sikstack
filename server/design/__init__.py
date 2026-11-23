"""Design builds: a design folder's static build, published, listed and served.

A linked checkout's engine uploads its design folder's build (``design/out/``, one
``tar.gz``) with the project's ``workspace`` key; every publish is kept. Members read
the list and a build's manifest on ``/app/``; each build is served on its own origin
(``server.design_serve``), entered by a short-lived ticket a member's session mints,
or by the build's share link while sharing is on.

- ``settings``: the environment (the builds folder, the origin pattern, the secret)
  and the caps.
- ``unpack``: the upload's safe unpacking under the caps.
- ``tokens``: the signed tickets and the design origin's cookies.
- ``store``: the ``design_builds`` rows and the files on disk.
"""
