FROM busybox:stable
RUN mkdir -p /www && uname -m > /www/arch
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
