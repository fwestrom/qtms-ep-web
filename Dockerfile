FROM node:4
ARG id=qtms-ep-web
COPY . /opt/$id
WORKDIR /opt/$id
ENTRYPOINT ["node", "/opt/qtms-ep-web"]
EXPOSE 3000
