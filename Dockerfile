FROM node:24-alpine

RUN npm install -g autoremediator@latest

WORKDIR /workdir

ENTRYPOINT ["autoremediator"]
CMD ["--help"]
